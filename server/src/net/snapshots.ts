// Per-client snapshots of a ServerGame. Once per snapshot tick `capture` reads the world into quantised
// entity values (shared/codec.ts layouts): soldiers (every bot and player, with a stable slot id), grenades,
// smoke clouds, the charge, pickups, gadgets and drones. Each connected client has a ClientView with the
// values it last received: `build` sends only the fields that changed (a field mask per entity), the
// entities that disappeared, the receiver's own state (the self block) and the events it may perceive.
//
// What a client is never sent: an enemy's health and armour, which attacker carries the charge (to
// defenders), feedback meant for another player (hit markers, blindness, messages), and enemy soldiers it
// cannot see (visibility culling: a living player gets an enemy only while a sight line from its eye
// reaches some part of that enemy, with a short grace and a little look-ahead so peeks do not pop; a dead
// player gets what its living teammates see). The HUD radar gets the enemies the team has spotted.

import * as C from "@cs/shared/codec";
import { MASK_SIGHT } from "@cs/shared/collision";
import { type V3, rightOf } from "@cs/shared/math";
import type { WeaponState } from "@cs/shared/weapons";
import { BotAgent } from "../ai/bot";
import { CATEGORIES, catalogue } from "../sim/shop";
import type { FxEvent } from "../sim/fx";
import type { ServerGame } from "../sim/game";
import { HumanAgent } from "../sim/human";
import type { Soldier } from "../sim/soldier";

type Values = number[][];
type Recipient = null | Soldier | ["team", number] | ["spectators"];

const VIS_GRACE = 0.35;          // seconds an enemy stays sent after the last sight line
const VIS_NEAR = 2.5;            // always sent this close (sound, bodies touching)
const LOOKAHEAD = 0.1;           // seconds of movement both sides are extrapolated by for the sight test
const RADAR_EVERY = 4;           // snapshots between radar updates (8 Hz at 32 Hz)
const SPOT_COS = Math.cos(60 * Math.PI / 180);

/** What one connection has been sent. agent: its player (null for a spectator); team: the team index it sees
 * as (null: everything, a spectator). */
export class ClientView {
  sent = new Map<number, [number, Values]>();
  sentPanels = new Map<number, string>();       // panel index -> flags:mask key, not intact
  seq = 0;
  full = true;
  bytesSent = 0;
  snapshots = 0;
  seenUntil = new Map<number, number>();         // enemy slot -> time it stays visible
  constructor(public userId: number, public agent: HumanAgent | null = null, public team: number | null = null) {}
}

export class SnapshotBuilder {
  game: ServerGame;
  items: string[];
  itemIndex: Map<string, number>;
  private slots = new Map<Participant0, number>();
  private nextSlot = 1;
  private objs = new Map<object, number>();
  private nextEid = 64;
  pending: Array<[Recipient, Uint8Array]> = [];
  private world = new Map<number, [number, object, Values]>();
  private soldierViews = new Map<number | null, Map<number, [number, Soldier, Values]>>();
  private panels = new Map<number, [number, Uint8Array, string]>();
  private teamSees: [Set<Soldier>, Set<Soldier>] = [new Set(), new Set()];
  private snapN = 0;
  private shopCache: Record<string, unknown> | null = null;

  constructor(game: ServerGame) {
    this.game = game;
    this.items = C.itemTable(Object.keys(game.weaponDb.weapons));
    this.itemIndex = new Map(this.items.map((k, i) => [k, i]));
    game.director.listeners.push((k, d) => this.matchEvent(k, d));
  }

  // ------------------------------------------------------------ ids
  slotOf(agent: Participant0): number {
    let s = this.slots.get(agent);
    if (s === undefined) {
      s = this.nextSlot++;
      this.slots.set(agent, s);
    }
    return s;
  }

  private eid(obj: object): number {
    let e = this.objs.get(obj);
    if (e === undefined) {
      e = this.nextEid;
      this.nextEid = 64 + ((this.nextEid - 63) % (65535 - 64));
      this.objs.set(obj, e);
    }
    return e;
  }

  /** Slot, name, team, bot or human of every participant (welcome and roster events). */
  roster(): Array<Record<string, unknown>> {
    return this.game.director.match.participants.map((p) => ({ slot: this.slotOf(p), name: p.name, team: p.team ? p.team.index : 255,
      bot: !p.isHuman }));
  }

  // --------------------------------------------------------- capture
  private itemOf(inv: { current(): WeaponState | null; slot: string; grenade: string | null }): number {
    const ws = inv.current();
    if (ws) return this.itemIndex.get(ws.d.key) ?? 0;
    if (inv.slot === "grenade" && inv.grenade) return this.itemIndex.get(inv.grenade) ?? 0;
    if (inv.slot === "bomb") return this.itemIndex.get("bomb_charge") ?? 0;
    return 0;
  }

  /** [values without health/armour, health, armour] of a bot or player. */
  private soldier(p: Soldier, carrier: Soldier | null): [Values, number, number] {
    const on = new Set<string>();
    let c, yaw: number, pitch: number, lean: number, walking: boolean;
    const ws = p.weapons.inv.current();
    if (p instanceof HumanAgent) {
      const mo = p.motor;
      c = mo.char; yaw = mo.yaw; pitch = mo.pitch; lean = mo.lean.amount;
      if (p.weapons.ads > 0.9 && ws && ws.zoomLevel > 0) on.add("scoped");
      if (p.plantT > 0) on.add("planting");
      if (p.defuseT > 0) on.add("defusing");
      on.add("human");
      walking = c.walking;
    } else {
      const b = p as BotAgent;
      c = b.char; yaw = b.aim.yaw; pitch = b.aim.pitch; lean = b.lean.amount;
      if (b.scoped) on.add("scoped");
      if ((b.brain?.plantT ?? 0) > 0) on.add("planting");
      if ((b.brain?.defuseT ?? 0) > 0) on.add("defusing");
      on.add("bot");
      walking = b.intent.walk;
    }
    if (p.alive) on.add("alive");
    if (c.crouched) on.add("crouched");
    if (walking) on.add("walking");
    if (ws && ws.reloading) on.add("reloading");
    if (c.onGround) on.add("on_ground");
    if (p === carrier) on.add("charge");
    const vals: Values = [C.qPos(c.pos), C.qPos(c.vel), [C.qYaw(yaw)], [C.qClamp(pitch, C.PITCH, -9000, 9000)],
      [C.bits(C.SOLDIER_FLAGS, on)], [C.qClamp(c.height - 1.0, 100.0, 0, 255)], [C.qClamp(lean, 127.0, -127, 127)],
      [this.itemOf(p.weapons.inv)], [p.team ? p.team.index : 255]];
    const d = p.damageable;
    return [vals, Math.max(0, Math.min(254, Math.round(d.health))), Math.max(0, Math.min(254, Math.round(d.armor)))];
  }

  /** Read the world once for this snapshot tick. */
  capture(): void {
    const g = this.game;
    const d = g.director;
    const carrier = d.bomb.state === "carried" ? d.bomb.carrier : null;
    const chargeBit = 1 << C.SOLDIER_FLAGS.indexOf("charge");
    // soldiers: three views (team 0, team 1, everything) differ in health, armour and the charge
    const views = new Map<number | null, Map<number, [number, Soldier, Values]>>([[0, new Map()], [1, new Map()], [null, new Map()]]);
    for (const p0 of d.match.participants) {
      const p = p0 as Soldier;
      if (!p.active && !p.isHuman) continue;
      const slot = this.slotOf(p);
      const [vals, hp, ar] = this.soldier(p, carrier);
      const team = p.team ? p.team.index : 255;
      const ev = [((p.animCounter & 31) << 3) | (p.animKind & 7)];
      for (const [viewer, out] of views) {
        const friend = viewer === null || viewer === team;
        const attackView = viewer === null || d.match.teams[viewer].side === "attack";
        const v = attackView ? vals : [...vals.slice(0, 4), [vals[4][0] & ~chargeBit], ...vals.slice(5)];
        out.set(slot, [C.KIND_SOLDIER, p, [...v, friend ? [hp] : [255], friend ? [ar] : [255], ev]]);
      }
    }
    this.soldierViews = views;
    const world = new Map<number, [number, object, Values]>();
    for (const gr of g.grenades) {
      if (gr.done) continue;
      world.set(this.eid(gr), [C.KIND_GRENADE, gr, [C.qPos(gr.pos), C.qPos(gr.vel), [this.itemIndex.get(gr.d.key) ?? 0]]]);
    }
    for (const cl of g.smoke.clouds) {
      world.set(this.eid(cl), [C.KIND_SMOKE, cl, [C.qPos(cl.pos), [C.qClamp(cl.radius, 10.0, 0, 255)], [C.qClamp(cl.age, 100.0, 0, 65535)],
        [C.qClamp(cl.duration, 1.0, 0, 255)]]]);
    }
    const b = d.bomb;
    if (["dropped", "planted", "defused", "exploded"].includes(b.state)) world.set(1000, [C.KIND_BOMB, b, [[C.BOMB_STATES.indexOf(b.state)], C.qPos(b.pos)]]);
    for (const pk of g.pickups.items) {
      if (!pk.available()) continue;
      let item = typeof pk.item === "string" ? pk.item : pk.item.d.key;
      if (pk.kind === "ammo" || pk.kind === "armor" || pk.kind === "grenades") item = `pickup_${pk.kind}`;
      world.set(this.eid(pk), [C.KIND_PICKUP, pk, [C.qPos(pk.pos), [C.qYaw(pk.heading)], [this.itemIndex.get(item) ?? 0]]]);
    }
    const tac = d.tactical;
    const teamOf = (side: string) => d.match.teams.find((t) => t.side === side)?.index ?? 255;
    for (const dep of [...tac.deployables, ...tac.cameras]) {
      if (!dep.alive) continue;
      const model = C.GADGET_KINDS.indexOf(dep.kind) + 1;
      world.set(this.eid(dep), [C.KIND_GADGET, dep, [C.qPos(dep.pos), [C.qYaw(dep.hpr[0])], [model], [teamOf(dep.side)], [dep.disabled ? 1 : 0]]]);
    }
    for (const dr of tac.drones) {
      if (!dr.alive) continue;
      world.set(this.eid(dr), [C.KIND_DRONE, dr, [C.qPos(dr.char.pos), [C.qYaw(dr.yaw)], [teamOf(dr.side)], [dr.jammed ? 1 : 0]]]);
    }
    this.world = world;
    // destructible panels that are not intact: index -> (flags, packed standing chunks)
    const panels = new Map<number, [number, Uint8Array, string]>();
    for (const p of g.destruction.panels) {
      if (p.version === 0 && !p.reinforced) continue;
      if (p.allAlive() && !p.reinforced) continue;
      const flags = p.reinforced ? C.PANEL_REINFORCED : 0;
      const mask = p.packedMask();
      panels.set(p.index, [flags, mask, `${flags}:${Buffer.from(mask).toString("base64")}`]);
    }
    this.panels = panels;
    const alive = new Set<object>([...world.values()].map(([, o]) => o));
    for (const o of [...this.objs.keys()]) if (!alive.has(o)) this.objs.delete(o);
    this.spotting();
  }

  // ----------------------------------------------------- visibility
  /** Can `eye` see any part of soldier `e` (extrapolated a little)? */
  private sightLine(eye: V3, eyeVel: V3, e: Soldier): boolean {
    const g = this.game;
    const v = e.velocity();
    const k = LOOKAHEAD;
    const ex: V3 = [eye[0] + eyeVel[0] * k, eye[1] + eyeVel[1] * k, eye[2]];
    const p = e.position();
    const dx = v[0] * k, dy = v[1] * k;
    const head = e.headPos(), chest = e.centerOfMass();
    const side = rightOf(e.yaw);
    const pts: V3[] = [
      [head[0] + dx, head[1] + dy, head[2] + 0.1], [chest[0] + dx, chest[1] + dy, chest[2]], [p[0] + dx, p[1] + dy, p[2] + 0.25],
      [chest[0] + dx + side[0] * 0.45, chest[1] + dy + side[1] * 0.45, chest[2] + 0.3],
      [chest[0] + dx - side[0] * 0.45, chest[1] + dy - side[1] * 0.45, chest[2] + 0.3],
    ];
    for (const eyeP of [eye, ex]) {
      for (const q of pts) {
        if (g.world.ray(eyeP, q, MASK_SIGHT) === null && g.smoke.between(eyeP, q) < 0.9) return true;
      }
    }
    return false;
  }

  /** The enemies each team has in sight right now: bots' seen contacts and players' sight lines in their view. */
  private spotting(): void {
    const d = this.game.director;
    const sees: [Set<Soldier>, Set<Soldier>] = [new Set(), new Set()];
    const parts = d.match.participants as Soldier[];
    for (const viewer of parts) {
      if (!viewer.alive || !viewer.team || (!viewer.active && !viewer.isHuman)) continue;
      const ti = viewer.team.index;
      if (viewer instanceof BotAgent) {
        for (const c of viewer.perception.contacts.values()) if (c.seen && c.agent.alive) sees[ti].add(c.agent);
        continue;
      }
      const h = viewer as HumanAgent;
      const eye = h.eye();
      const fwd = h.viewDir();
      for (const e of parts) {
        if (!e.alive || !e.team || e.team.index === ti || (!e.active && !e.isHuman)) continue;
        const c = e.centerOfMass();
        const to: V3 = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
        const dist = Math.hypot(to[0], to[1], to[2]);
        if (dist > 1e-3 && (to[0] * fwd[0] + to[1] * fwd[1] + to[2] * fwd[2]) / dist < SPOT_COS) continue;
        if (this.sightLine(eye, h.velocity(), e)) sees[ti].add(e);
      }
    }
    this.teamSees = sees;
  }

  /** Whether a living player (or a dead one, through its team) may receive enemy soldier `e`. */
  private visibleTo(view: ClientView, e: Soldier, now: number): boolean {
    const a = view.agent;
    if (!a || view.team === null) return true;
    if (!e.team || e.team.index === view.team || !e.alive) return true;
    if (!a.alive) return this.teamSees[view.team].has(e);
    const slot = this.slotOf(e);
    const eye = a.eye();
    const ep = e.position();
    let vis = Math.hypot(ep[0] - eye[0], ep[1] - eye[1]) < VIS_NEAR || this.teamSees[view.team].has(e);
    if (!vis) vis = this.sightLine(eye, a.velocity(), e);
    if (vis) {
      view.seenUntil.set(slot, now + VIS_GRACE);
      return true;
    }
    return now < (view.seenUntil.get(slot) ?? -1);
  }

  // ---------------------------------------------------------- events
  /** Match events -> JSON events for everyone (kill feed, rounds, money for its owner). */
  private matchEvent(kind: string, data: Record<string, any>): void {
    const name = (p: Participant0 | null | undefined) => (p ? { slot: this.slotOf(p), name: p.name } : null);
    let out: Record<string, unknown> | null = null;
    let to: Recipient = null;
    if (kind === "kill") {
      out = { kind: "kill", killer: name(data.killer), victim: name(data.victim), assister: name(data.assister), weapon: data.weapon ?? "",
        headshot: !!data.headshot };
    } else if (kind === "round_end") {
      const r = data.result;
      out = { kind: "round_end", winner_side: r.winnerSide, reason: r.reason, round: r.number, mvp: r.mvp };
    } else if (kind === "money") {
      out = { kind: "money", amount: data.amount, reason: data.reason };
      to = data.who;
    } else if (["phase", "round_start", "bomb_planted", "bomb_defused", "bomb_exploded", "halftime", "sides_swapped", "match_end", "overtime"].includes(kind)) {
      out = { kind };
      if (kind === "phase") out.phase = data.phase;
      if (kind === "match_end") {
        out.winner_team = data.winner ? data.winner.index : null;
        out.forfeit = data.forfeit ?? null;
      }
    } else if (kind === "radio") {
      const who = data.who as Soldier | null;
      const team = who && who.team ? who.team.index : null;
      out = { kind: "radio", who: name(who), text: data.text ?? "", team };
      to = ["team", team ?? -1];
    }
    if (out) this.pending.push([to, C.jsonEvent(out)]);
  }

  /** RecordingFx events of the ticks since the last snapshot. */
  addFx(events: FxEvent[]): void {
    const P = C.qPos;
    for (const e of events) {
      const to = (e.to ?? null) as Recipient;
      let packed: Uint8Array | null = null;
      const pos = e.pos as V3;
      switch (e.kind) {
        case "tracer": packed = C.packEvent(C.EV_TRACER, [...P(e.start as V3), ...P(e.end as V3)]); break;
        case "impact": {
          const n = e.normal as V3;
          packed = C.packEvent(C.EV_IMPACT, [...P(pos), ...n.map((v) => C.qClamp(v, 127.0, -127, 127)), e.surface as string]);
          break;
        }
        case "sound": packed = C.packEvent(C.EV_SOUND, [...P(pos), C.qClamp(e.volume as number, 100.0, 0, 255), e.name as string]); break;
        case "footstep": packed = C.packEvent(C.EV_FOOTSTEP, [...P(pos), C.qClamp(e.loudness as number, 100.0, 0, 255), e.surface as string]); break;
        case "shot_sound": {
          const who = e.shooter as Participant0 | null;
          packed = C.packEvent(C.EV_SHOT, [who ? this.slotOf(who) : 0, ...P(pos), e.profile as string]);
          break;
        }
        case "explosion": case "big_explosion":
          packed = C.packEvent(C.EV_EXPLOSION, [...P(pos), C.qClamp((e.radius as number) ?? 20, 4.0, 0, 255), e.kind === "big_explosion" ? 1 : 0]);
          break;
        case "flashbang": packed = C.packEvent(C.EV_FLASH, [...P(pos)]); break;
        case "hit_marker": packed = C.packEvent(C.EV_HIT, [(e.killed ? 1 : 0) | (e.headshot ? 2 : 0)]); break;
        case "blind": packed = C.packEvent(C.EV_BLIND, [C.qClamp(e.duration as number, 20.0, 0, 255), C.qClamp(e.strength as number, 255.0, 0, 255)]); break;
        case "message": packed = C.jsonEvent({ kind: "message", text: e.text }); break;
        case "damage_from": packed = C.jsonEvent({ kind: "damage", from: (e.source as V3).map((v) => Math.round(v * 100) / 100),
          amount: Math.round((e.amount as number) * 10) / 10 }); break;
        case "ui": if (to) packed = C.jsonEvent({ kind: "ui", name: e.name }); break;
        case "sting": packed = C.jsonEvent({ kind: "sting", name: e.name }); break;
        case "emp": packed = C.jsonEvent({ kind: "emp", pos: pos.map((v) => Math.round(v * 100) / 100), radius: e.radius }); break;
        default: break;
      }
      if (packed) this.pending.push([to, packed]);
    }
  }

  /** The team radar: spotted enemies and tactical pings, a few times a second. */
  private radarEvents(): void {
    const d = this.game.director;
    for (const t of d.match.teams) {
      for (const e of this.teamSees[t.index]) {
        const p = e.position();
        this.pending.push([["team", t.index], C.packEvent(C.EV_RADAR, [this.slotOf(e), ...C.qPos(p)])]);
      }
      const now = this.game.loop.time;
      for (const ping of d.tactical.teamPings(t.side)) {
        if (ping.until < now) continue;
        const p = ping.where();
        this.pending.push([["team", t.index], C.packEvent(C.EV_RADAR, [ping.agent ? this.slotOf(ping.agent) : 0, ...C.qPos(p)])]);
      }
      // teammates' money for the scoreboard, when it changes (CS shows your own team's)
      const money: Record<number, number> = {};
      for (const a of t.members) money[this.slotOf(a)] = a.money;
      const key = JSON.stringify(money);
      if (key !== this.moneySent[t.index]) {
        this.moneySent[t.index] = key;
        this.pending.push([["team", t.index], C.jsonEvent({ kind: "team_money", money })]);
      }
    }
  }
  private moneySent: string[] = ["", ""];

  private eventsFor(view: ClientView): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const [to, packed] of this.pending) {
      if (to === null) out.push(packed);
      else if (Array.isArray(to)) {
        if (to[0] === "team" && (view.team === null || view.team === to[1])) out.push(packed);
        else if (to[0] === "spectators" && view.agent === null) out.push(packed);
      } else if (to === view.agent) out.push(packed);
    }
    return out;
  }

  // ----------------------------------------------------------- build
  matchValues(): number[] {
    const d = this.game.director;
    const m = d.match;
    const [t0, t1] = m.teams;
    const ph = C.PHASES.indexOf(m.phase);
    const bs = C.BOMB_STATES.indexOf(d.bomb.state);
    return [ph >= 0 ? ph : 0, C.qClamp(m.clock(), 10.0, 0, 65535), Math.min(m.round, 255), t0.score, t1.score, t0.side === "attack" ? 0 : 1,
      t0.aliveMembers().length, t1.aliveMembers().length, bs >= 0 ? bs : 0, C.qClamp(m.buyTimeLeft(), 1.0, 0, 255)];
  }

  selfValues(agent: HumanAgent): number[] {
    const d = this.game.director;
    const mo = agent.motor;
    const c = mo.char;
    const w = agent.weapons;
    const inv = w.inv;
    const ws = inv.current();
    const tac = d.tactical;
    const flags = new Set<string>();
    const pairs: Array<[string, boolean]> = [["on_ground", c.onGround], ["crouched", c.crouched], ["walking", c.walking],
      ["move_lock", mo.moveLock], ["lean_lock", mo.leanLock], ["helmet", agent.damageable.helmet], ["kit", agent.hasKit],
      ["charge", inv.hasBomb], ["alive", agent.alive], ["observing", tac.observingFor(agent)],
      ["can_buy", d.match.canBuy() && d.inBuyZone(agent)]];
    for (const [n, on] of pairs) if (on) flags.add(n);
    const progress = agent.progress;
    const pk = progress ? Math.max(0, C.PROGRESS_KINDS.indexOf(progress[0])) : 0;
    const prim = inv.weapons.primary, sec = inv.weapons.secondary;
    const nade = C.GRENADE_KEYS.map((k) => Math.min(255, inv.grenades[k] ?? 0));
    const n = c.groundNormal;
    const kit = tac.kit(agent);
    const st = tac.state(agent);
    const view = st.view;
    const viewSlot = view ? 1 + ([...tac.drones, ...tac.cameras] as object[]).indexOf(view) : 0;
    const veye = view ? view.eye() : [0, 0, 0];
    const gi = kit.gadget ? this.gadgetIndex(kit.gadget) : 0;
    const slot = C.INV_SLOTS.indexOf(inv.slot);
    return [this.slotOf(agent), c.pos[0], c.pos[1], c.pos[2], c.vel[0], c.vel[1], c.vel[2], c.height, n[0], n[1], n[2],
      c.jumpCooldown, c.landingTimer, c.airTime, c.stride, mo.jumpBuffer, mo.lean.amount, mo.speedScale, mo.slow, mo.yaw, mo.pitch,
      C.bits(C.SELF_FLAGS, flags), Math.max(0, Math.min(255, Math.round(agent.damageable.health))),
      Math.max(0, Math.min(255, Math.round(agent.damageable.armor))), Math.max(0, Math.min(65535, agent.money)),
      slot >= 0 ? slot : 2, this.itemOf(inv), ws ? ws.ammo : 0, ws ? Math.min(ws.reserve, 65535) : 0,
      prim ? this.itemIndex.get(prim.d.key) ?? 0 : 0, sec ? this.itemIndex.get(sec.d.key) ?? 0 : 0, ...nade,
      ws ? ws.zoomLevel : 0, C.qClamp(w.ads, 255.0, 0, 255), pk, progress ? C.qClamp(progress[1], 255.0, 0, 255) : 0,
      gi, Math.min(255, kit.gadgetLeft), Math.min(255, kit.charges), Math.min(255, kit.drones), Math.min(255, kit.reinforcements),
      Math.max(0, Math.min(65535, viewSlot)), veye[0], veye[1], veye[2], view ? view.yaw : 0, view ? view.pitch : 0];
  }

  private gadgetList: string[] | null = null;
  /** Index (1-based) of a gadget key in the specialists' gadget table, sent in the welcome. */
  gadgetIndex(key: string): number {
    if (!this.gadgetList) this.gadgetList = Object.keys(this.game.director.tactical.gcfg);
    return this.gadgetList.indexOf(key) + 1;
  }

  /** The next snapshot for one client (after `capture` for this tick). */
  build(view: ClientView, tick: number): Uint8Array {
    const now = this.game.loop.time;
    const team = view.team;
    const soldiers = this.soldierViews.get(team === 0 || team === 1 ? team : null) ?? new Map();
    const current = new Map<number, [number, Values]>();
    for (const [eid, [kind, obj, vals]] of soldiers) if (this.visibleTo(view, obj, now)) current.set(eid, [kind, vals]);
    for (const [eid, [kind, , vals]] of this.world) current.set(eid, [kind, vals]);
    const full = view.full;
    const sent = full ? new Map<number, [number, Values]>() : view.sent;
    const entities: C.SnapEntity[] = [];
    for (const [eid, [kind, vals]] of current) {
      const old = sent.get(eid);
      if (!old || old[0] !== kind) {
        entities.push({ id: eid, kind, mask: C.allMask(C.KINDS[kind].fields), values: vals.flat() });
        continue;
      }
      let mask = 0;
      const flat: number[] = [];
      vals.forEach((a, i) => {
        const b = old[1][i];
        if (a.length !== b.length || a.some((x, j) => x !== b[j])) {
          mask |= 1 << i;
          flat.push(...a);
        }
      });
      if (mask) entities.push({ id: eid, kind, mask, values: flat });
    }
    const removed = [...sent.keys()].filter((eid) => !current.has(eid));
    const base = view.seq;
    view.seq++;
    const agent = view.agent;
    const me = agent && agent.team ? this.selfValues(agent) : null;
    const ack = agent ? agent.lastCmd.seq : 0;
    const sentPanels = full ? new Map<number, string>() : view.sentPanels;
    const panels: C.SnapPanel[] = [];
    for (const [i, [f, m, key]] of this.panels) if (sentPanels.get(i) !== key) panels.push({ index: i, flags: f, mask: m });
    for (const i of sentPanels.keys()) if (!this.panels.has(i)) panels.push({ index: i, flags: C.PANEL_INTACT, mask: new Uint8Array(0) });
    const data = C.encodeSnapshot(view.seq, full ? 0 : base, tick, ack, this.matchValues(), me, entities, removed, this.eventsFor(view), full, panels);
    view.sent = current;
    view.sentPanels = new Map([...this.panels].map(([i, v]) => [i, v[2]]));
    view.full = false;
    view.bytesSent += data.length;
    view.snapshots++;
    return data;
  }

  /** After every client's build of a snapshot tick. */
  endSnapshot(): void {
    this.pending = [];
    this.snapN++;
    if (this.snapN % RADAR_EVERY === 0) this.radarEvents();
  }

  clearEvents(): void { this.pending = []; }

  welcome(view: ClientView, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const g = this.game;
    const d = g.director;
    return { protocol: C.PROTOCOL_VERSION, items: this.items, roster: this.roster(), slot: view.agent ? this.slotOf(view.agent) : null,
      team: view.team, map: g.level.mapKey, tick_rate: Math.round(1 / g.loop.dt), server_tick: g.loop.tickCount,
      teams: d.match.teams.map((t) => ({ index: t.index, side: t.side })),
      rules: { timers: d.rules.timers, rounds: d.rules.rounds, friendly_fire: !!d.rules.friendly_fire },
      shop: this.shop(), gadgets: Object.keys(d.tactical.gcfg), ...extra };
  }

  /** The buy menu per side: [[category title, [{key, name, price, info, kind}]]]. */
  shop(): Record<string, unknown> {
    if (!this.shopCache) {
      const out: Record<string, unknown> = {};
      for (const side of ["attack", "defend"]) {
        const cats = catalogue(this.game.weaponDb, this.game.director.rules, side);
        out[side] = CATEGORIES.filter(([k]) => cats[k]?.length).map(([k, title]) => [title, cats[k].map((it) => ({ key: it.key, name: it.name,
          price: it.price, info: it.info, kind: it.kind }))]);
      }
      this.shopCache = out;
    }
    return this.shopCache;
  }
}

type Participant0 = { name: string; isHuman: boolean; team: { index: number } | null };
