// Keeps the navmesh in step with destruction. The navmesh is baked with every panel intact; when a panel
// changes shape this finds openings a character fits through and adds off-mesh links:
// * a wall with a hole from the floor up to crouch height, at least MIN_WIDTH wide, links the floor on
//   both sides (two-way);
// * a floor or roof hatch with an opening of MIN_WIDTH square links the roof to the floor below (a one-way
//   drop). A new round restores every panel and removes all links.

import type { Panel } from "@cs/shared/destruction";
import type { DestructionManager } from "../sim/destruction";
import type { NavMesh } from "./navmesh";

const HULL = 0.30;
const MIN_WIDTH = 0.8;
const MIN_HEIGHT = 1.3;
const SIDE = 0.55;

export class NavLinks {
  nav: NavMesh;
  links = new Map<number, unknown[]>();

  constructor(nav: NavMesh, destruction: DestructionManager) {
    this.nav = nav;
    destruction.listeners.push((p) => this.onPanel(p));
    for (const p of destruction.panels) if (p.version > 0) this.onPanel(p);
  }

  onPanel(panel: Panel | null): void {
    if (!panel) {
      this.nav.clearLinks();
      this.links.clear();
      return;
    }
    this.nav.removeLinks(panel.index);
    this.links.delete(panel.index);
    if (panel.reinforced || panel.allAlive()) return;
    if (panel.spec.kind === "floor") this.floor(panel);
    else this.wall(panel);
  }

  private wall(panel: Panel): void {
    const [a, b] = panel.ax;
    const R = panel.R;
    let vert: number, horiz: number, cu: number, cv: number;
    let aliveAt: (u: number, v: number) => number;
    let nu: number, nvv: number;
    if (Math.abs(R[b][2]) > 0.9) {
      vert = b; horiz = a; cu = panel.cu; cv = panel.cv; nu = panel.nu; nvv = panel.nv;
      aliveAt = (u, v) => panel.alive[u * panel.nv + v];
    } else if (Math.abs(R[a][2]) > 0.9) {
      vert = a; horiz = b; cu = panel.cv; cv = panel.cu; nu = panel.nv; nvv = panel.nu;
      aliveAt = (u, v) => panel.alive[v * panel.nv + u];
    } else return;
    const height = panel.size[vert];
    if (height < MIN_HEIGHT) return;
    const sign = R[vert][2] > 0 ? 1 : -1;
    const rows = Math.min(Math.ceil(MIN_HEIGHT / cv), nvv);
    const open: boolean[] = [];
    for (let u = 0; u < nu; u++) {
      let any = false;
      for (let k = 0; k < rows; k++) {
        const v = sign > 0 ? k : nvv - 1 - k;
        if (aliveAt(u, v)) { any = true; break; }
      }
      open.push(!any);
    }
    const bottomZ = panel.center[2] - height / 2;
    let i = 0;
    while (i < nu) {
      if (!open[i]) { i++; continue; }
      let j = i;
      while (j + 1 < nu && open[j + 1]) j++;
      if ((j - i + 1) * cu >= MIN_WIDTH) {
        const u0 = -panel.size[horiz] / 2 + i * cu, u1 = -panel.size[horiz] / 2 + (j + 1) * cu;
        this.wallLink(panel, horiz, vert, sign, u0, u1, bottomZ);
      }
      i = j + 1;
    }
  }

  private wallLink(panel: Panel, horiz: number, vert: number, sign: number, u0: number, u1: number, bottomZ: number): void {
    const nav = this.nav;
    const halfT = panel.size[panel.thin] / 2;
    const uc = (u0 + u1) / 2;
    const world = (u: number, off: number) => {
      const loc = [0, 0, 0];
      loc[horiz] = u;
      loc[vert] = -sign * panel.size[vert] / 2;
      loc[panel.thin] = off;
      return panel.toWorld(loc);
    };
    const pa = world(uc, halfT + SIDE), pb = world(uc, -(halfT + SIDE));
    const ra = nav.rectAt([pa[0], pa[1], bottomZ], 3, 0.5), rb = nav.rectAt([pb[0], pb[1], bottomZ], 3, 0.5);
    if (ra < 0 || rb < 0 || ra === rb) return;
    const m = Math.max((u1 - u0) / 2 - HULL, 0.05);
    const e0 = world(uc - m, 0), e1 = world(uc + m, 0);
    nav.addLink(panel.index, ra, rb, [e0[0], e0[1]], [e1[0], e1[1]], true);
    this.pushLink(panel.index, ["wall", ra, rb]);
  }

  private floor(panel: Panel): void {
    const [a, b] = panel.ax;
    const wa = Math.ceil(MIN_WIDTH / panel.cu - 1e-6), wb = Math.ceil(MIN_WIDTH / panel.cv - 1e-6);
    const nu = panel.nu, nv = panel.nv;
    if (wa > nu || wb > nv) return;
    const dead = (i: number, j: number) => (panel.alive[i * nv + j] ? 0 : 1);
    // summed-area table of the open chunks
    const sat = new Int32Array((nu + 1) * (nv + 1));
    for (let i = 1; i <= nu; i++) for (let j = 1; j <= nv; j++) {
      sat[i * (nv + 1) + j] = dead(i - 1, j - 1) + sat[(i - 1) * (nv + 1) + j] + sat[i * (nv + 1) + j - 1] - sat[(i - 1) * (nv + 1) + j - 1];
    }
    const ok: Array<[number, number]> = [];
    for (let i = 0; i + wa <= nu; i++) for (let j = 0; j + wb <= nv; j++) {
      const s = sat[(i + wa) * (nv + 1) + j + wb] - sat[i * (nv + 1) + j + wb] - sat[(i + wa) * (nv + 1) + j] + sat[i * (nv + 1) + j];
      if (s === wa * wb) ok.push([i, j]);
    }
    if (!ok.length) return;
    let ci = 0, cj = 0, n = 0;
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) if (dead(i, j)) { ci += i; cj += j; n++; }
    ci /= n; cj /= n;
    let best = ok[0], bd = Infinity;
    for (const [i0, j0] of ok) {
      const d = (i0 + (wa - 1) / 2 - ci) ** 2 + (j0 + (wb - 1) / 2 - cj) ** 2;
      if (d < bd) { bd = d; best = [i0, j0]; }
    }
    const loc = [0, 0, 0];
    loc[a] = -panel.size[a] / 2 + (best[0] + wa / 2) * panel.cu;
    loc[b] = -panel.size[b] / 2 + (best[1] + wb / 2) * panel.cv;
    const c = panel.toWorld(loc);
    const top = panel.center[2] + panel.size[panel.thin] / 2;
    const bottom = panel.center[2] - panel.size[panel.thin] / 2;
    const nav = this.nav;
    const ra = nav.rectAt([c[0], c[1], top], 2, 0.3);
    const rb = nav.rectBelow(c[0], c[1], bottom - 0.2);
    if (ra < 0 || rb < 0 || ra === rb) return;
    nav.addLink(panel.index, ra, rb, [c[0] - 0.1, c[1]], [c[0] + 0.1, c[1]], false);
    this.pushLink(panel.index, ["drop", ra, rb]);
  }

  private pushLink(index: number, v: unknown): void {
    let l = this.links.get(index);
    if (!l) this.links.set(index, (l = []));
    l.push(v);
  }
}
