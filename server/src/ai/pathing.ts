// Path queries for the bots: resumable A* under a per-tick budget, cached.
// * A request returns the path at once when the portal chain between the two navmesh rects is cached (only
//   the funnel runs per request), else PENDING.
// * Pending searches are AStarJobs: the navmesh's A* (both portal scorings, keeping the shorter route) in
//   steps; `update` spends at most `budget` expansions per tick, so the cost is bounded and deterministic.
// * Cost biases are named by a small integer key, so bots with the same key share cached results.
// * The cache is dropped when the navmesh's dynamic links change (a wall opened, a new round).

import type { V3 } from "@cs/shared/math";
import { AStarSearch, type NavMesh, type Pt2, type Pt3, stringPull } from "./navmesh";
import { PathFollower } from "./steering";

export const PENDING = "pending" as const;
export type PathResult = Pt3[] | null | typeof PENDING;

export class AStarJob {
  nav: NavMesh;
  sr: number; gr: number; sxy: Pt2; gxy: Pt2;
  bias: ((r: number) => number) | null;
  done = false;
  chain: number[] | null = null;
  expanded = 0;
  private mode = 0;
  private found: number[][] = [];
  private search: AStarSearch;

  constructor(nav: NavMesh, sr: number, gr: number, sxy: Pt2, gxy: Pt2, bias: ((r: number) => number) | null = null) {
    this.nav = nav; this.sr = sr; this.gr = gr; this.sxy = sxy; this.gxy = gxy; this.bias = bias;
    this.search = new AStarSearch(nav, sr, gr, sxy, gxy, bias, false);
  }

  /** Expand up to budget rects (over both scorings); returns how many were used. */
  step(budget: number): number {
    let used = 0;
    while (!this.done && used < budget) {
      const s = this.search;
      const before = s.expanded;
      used += s.step(budget - used);
      this.expanded += s.expanded - before;
      if (s.finished) this.finish();
    }
    return used;
  }

  /** One scoring done: start the next, or keep the shorter of the two routes. */
  private finish(): void {
    const ch = this.search.chain();
    if (!ch) { this.done = true; this.chain = null; return; }
    this.found.push(ch);
    this.mode++;
    if (this.mode < 2) {
      this.search = new AStarSearch(this.nav, this.sr, this.gr, this.sxy, this.gxy, this.bias, true);
      return;
    }
    this.done = true;
    const length = (c: number[]) => {
      const pts = stringPull(this.sxy, this.gxy, this.nav.orientedPortals(c));
      let s = 0;
      for (let i = 0; i < pts.length - 1; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      return s;
    };
    let best: number[] | null = null;
    for (const c of this.found) if (!best || length(c) < length(best) - 1e-6) best = c;
    this.chain = best;
  }
}

/** Corners of the shortest path through a portal chain, with floor heights. */
export function assemble(nav: NavMesh, start: ArrayLike<number>, goal: ArrayLike<number>, chain: number[]): Pt3[] {
  const sn = nav.locate(start), gn = nav.locate(goal);
  const sxy: Pt2 = [start[0], start[1]], gxy: Pt2 = [goal[0], goal[1]];
  const pts2 = chain.length ? stringPull(sxy, gxy, nav.orientedPortals(chain)) : [sxy, gxy];
  return nav.withHeights(sn, gn, sxy, gxy, pts2, chain);
}

export class PathService {
  nav: NavMesh;
  budget: number;
  cache = new Map<string, number[] | null>();     // insertion order = LRU order
  jobs = new Map<string, AStarJob>();
  queue: string[] = [];
  biases = new Map<number, (r: number) => number>();
  cacheSize: number;
  private linksSig = "";
  stats = { requests: 0, hits: 0, searches: 0, expansions: 0 };

  constructor(nav: NavMesh, budget = 260, cacheSize = 600) {
    this.nav = nav;
    this.budget = budget;
    this.cacheSize = cacheSize;
  }

  /** Register (or replace) a cost bias; results computed with the old one are dropped. */
  setBias(key: number, fn: (r: number) => number): void {
    this.biases.set(key, fn);
    for (const k of [...this.cache.keys()]) if (k.endsWith(`:${key}`)) this.cache.delete(k);
  }

  private sig(): string {
    let n = 0;
    for (const v of this.nav.dyn.values()) n += v.length;
    return `${this.nav.portalList.length}:${n}:${this.nav.dyn.size}`;
  }

  /** A path, null if unreachable, or PENDING. */
  request(start: ArrayLike<number>, goal: ArrayLike<number>, biasKey = 0): PathResult {
    this.stats.requests++;
    const nav = this.nav;
    const sn = nav.locate(start), gn = nav.locate(goal);
    if (sn < 0 || gn < 0) return null;
    const sr = nav.rectOf[sn], gr = nav.rectOf[gn];
    if (sr === gr) {
      this.stats.hits++;
      return assemble(nav, start, goal, []);
    }
    const key = `${sr}:${gr}:${biasKey}`;
    if (this.cache.has(key)) {
      this.stats.hits++;
      const chain = this.cache.get(key) as number[] | null;
      this.cache.delete(key);
      this.cache.set(key, chain);
      return chain === null ? null : assemble(nav, start, goal, chain);
    }
    if (!this.jobs.has(key)) {
      this.jobs.set(key, new AStarJob(nav, sr, gr, [start[0], start[1]], [goal[0], goal[1]], this.biases.get(biasKey) ?? null));
      this.queue.push(key);
      this.stats.searches++;
    }
    return PENDING;
  }

  update(): number {
    const sig = this.sig();
    if (sig !== this.linksSig) {
      this.linksSig = sig;
      this.cache.clear();
      // running searches may use a removed link: start them again
      for (const [key, j] of this.jobs) this.jobs.set(key, new AStarJob(this.nav, j.sr, j.gr, j.sxy, j.gxy, j.bias));
    }
    let left = this.budget;
    while (this.queue.length && left > 0) {
      const key = this.queue[0];
      const job = this.jobs.get(key) as AStarJob;
      left -= Math.max(job.step(left), 1);
      if (job.done) {
        this.queue.shift();
        this.jobs.delete(key);
        this.cache.set(key, job.chain);
        this.stats.expansions += job.expanded;
        if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as string);
      }
    }
    return this.budget - left;
  }
}

/** PathFollower whose re-plan after getting stuck goes through the service. */
export class FollowerV2 extends PathFollower {
  service: PathService;
  biasKey = 0;

  constructor(nav: NavMesh, service: PathService) {
    super(nav);
    this.service = service;
  }

  protected override repath(pos: V3): void {
    if (!this.goal) return;
    this.repaths++;
    const path = this.service.request(pos, this.goal, this.biasKey);
    if (path === null) {
      this.failed = true;
      this.path = [];
    } else if (path !== PENDING) this.set(path);
  }
}
