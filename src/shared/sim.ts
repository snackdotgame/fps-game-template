// The deterministic game simulation, extracted from the server so clients
// can eventually run it too (docs/netcode-input-sync.md). One Jolt world
// stepped at the tick rate; players are dynamic capsules driven by the
// shared controller, which fires weapon hooks resolved here: hitscan
// raycasts, sledgehammer swings, grenade bodies, and cover deployment.
// Panels lose HP to gunfire and melee, explosions delete them in a radius.
// The sim never touches the network: reliable messages are pushed onto
// `outbox` (the server drains and broadcasts them verbatim each tick),
// transient effects (tracers, impacts, explosions) ride the `events` ring,
// and all randomness flows through one seeded rng.

import {
  BLEED_INTERVAL_TICKS,
  EXPLOSION_IMPULSE,
  EXPLOSION_MAX_DAMAGE,
  EXPLOSION_MIN_DAMAGE,
  EXPLOSION_PANEL_OUTER_DAMAGE,
  EXPLOSION_PANEL_OUTER_RADIUS,
  EXPLOSION_PANEL_RADIUS,
  EXPLOSION_RADIUS,
  GRENADE_FUSE_TICKS,
  HEADSHOT_HEIGHT,
  MAX_HP,
  MAX_PLAYERS,
  MELEE_DAMAGE,
  MELEE_PANEL_DAMAGE,
  MELEE_RANGE,
  OOB_LIMIT_TICKS,
  PROTECT_TICKS,
  REGEN_DELAY_TICKS,
  REGEN_PER_TICK,
  RESPAWN_TICKS,
  ROUND_TICKS,
  RUBBLE_HEIGHT,
  SANDBOX,
  TICK_MS,
  TICK_RATE,
  TICKETS_START,
  ZONE_CAP_RATE,
} from "./constants.js";
import { CLASSES, classPrimaryIdx, weaponByIdx } from "./weapons.js";
import {
  addCrater,
  BUILT_PANEL_ID_BASE,
  buildContactIndex,
  type Crater,
  heightAt,
  inEnemyBase,
  MAP,
  PANEL_HP,
  type PanelDef,
  type PanelMaterial,
  PLAY_HALF,
  resetCraters,
  slabOfPiece,
  spawnPoint,
  ZONES,
} from "./map.js";
import { SPAWN_AUTO, SPAWN_HQ, type ServerMsg } from "./messages.js";
import {
  EV_EXPLOSION,
  EV_HIT_PLAYER,
  EV_MELEE,
  EV_PANEL_HIT,
  EV_TRACER,
  type GameEvent,
  unwrapViewTick,
} from "./netCodec.js";
import {
  activeWeapon,
  addPanelBody,
  addRubbleBody,
  applyCraterBodies,
  type Body,
  castWallDistance,
  type CharState,
  muzzleOrigin,
  createFallingChunkBody,
  createGameWorld,
  createGrenadeBody,
  createPlayerBody,
  destroyGameWorld,
  type GameWorld,
  type InputCmd,
  makeChar,
  perturb,
  pieceIdFromHit,
  PLAYER_HALF_HEIGHT,
  rayVsCapsule,
  readChar,
  rebuildSlabBody,
  removeGrenadeBody,
  removePanelBody,
  removePlayerBody,
  spreadFor,
  stepPlayerController,
  writeChar,
  ZERO_INPUT,
} from "./physics.js";

const EVENT_RING = 12;

// Where this player's capsule was `rewindTicks` ago (clamped to what we
// know) — the position the shooter actually saw on their screen.
// Per-player rewind history as a flat ring buffer: one reused Float64Array
// per player instead of 30 short-lived arrays a second, and one stable
// hidden class for V8. `rewound` returns a reused scratch — consume it
// before the next call.
const HISTORY_TICKS = 12;

export class PositionHistory {
  private readonly data = new Float64Array(HISTORY_TICKS * 3);
  private readonly out: [number, number, number] = [0, 0, 0];
  private head = 0;
  private count = 0;

  push(x: number, y: number, z: number): void {
    const i = this.head * 3;
    this.data[i] = x;
    this.data[i + 1] = y;
    this.data[i + 2] = z;
    this.head = (this.head + 1) % HISTORY_TICKS;
    if (this.count < HISTORY_TICKS) this.count++;
  }

  clear(): void {
    this.count = 0;
  }

  rewound(rewindTicks: number): readonly number[] | null {
    if (this.count === 0) return null;
    const back = Math.max(1, Math.min(rewindTicks, this.count));
    const i = ((this.head - back + HISTORY_TICKS) % HISTORY_TICKS) * 3;
    this.out[0] = this.data[i];
    this.out[1] = this.data[i + 1];
    this.out[2] = this.data[i + 2];
    return this.out;
  }
}

// The simulation half of a player. Connection identity, bot brains, and
// input buffering live in the server's wrapper objects, keyed by slot.
export interface SimPlayer {
  idx: number; // slot, 0..MAX_PLAYERS-1
  team: number;
  body: Body;
  state: CharState;
  lastCmd: InputCmd; // last applied input (snapshot flags read it)
  hp: number;
  dead: boolean;
  // Feet positions for the last few ticks (ring, newest last) — hit
  // registration rewinds against these so shots land where shooters SAW
  // their targets, not where targets are now.
  history: PositionHistory;
  respawnAtTick: number;
  protectUntilTick: number;
  lastDamageTick: number;
  kills: number;
  deaths: number;
  oobSinceTick: number; // tick this player left the play area, or -1 if in bounds
  // Requested respawn point: a ZONES index, SPAWN_HQ, or SPAWN_AUTO (default;
  // bots always stay on auto). Honored while the team holds the flag.
  spawnZone: number;
  // CLASSES index; decides the primary weapon (and the character model
  // clients render). Picked from the deploy screens, applied at spawn.
  classId: number;
  // Humans (autoRespawn=false, set by the server) stay down until they send a
  // deploy request; the respawn timer is the minimum, not the trigger. Bots
  // keep the automatic respawn.
  autoRespawn: boolean;
  wantsRespawn: boolean;
}

export interface Grenade {
  id: number;
  ownerIdx: number;
  fuseLeft: number;
  body: Body;
}

// Pieces released by the support cascade: intact, dynamic, tumbling under
// the server's sim until they settle and re-freeze as static pieces.
export interface FallingChunk {
  id: number;
  origin: [number, number, number];
  pieces: PanelDef[]; // world-space defs at release time; local = piece - origin
  body: Body;
  calmTicks: number;
  bornTick: number;
}

const FALLING_CAP = 24; // concurrent chunks (each may hold dozens of pieces)
const FALL_TIMEOUT_TICKS = 6 * TICK_RATE;

// Conquest zone state, parallel to map.ZONES. v in [-100, 100]: negative is
// team 0's side, positive team 1's; owner flips at the poles and neutralizes
// when the meter is pushed back through zero.
export interface ZoneState {
  owner: number; // -1 neutral, 0, 1
  v: number;
}

export interface ApplyInputOpts {
  locked?: boolean; // dead / round over / no input yet: ignore action inputs
  bufferWait?: number; // server-side input-buffer wait (apply tick - arrival tick)
  isBot?: boolean; // bots aim at the live world (rewind 1)
}

interface AttackHit {
  victim: SimPlayer | null;
  panelBody: Body | null;
  point: [number, number, number];
  headshot: boolean;
}

// Per-map indexes over the static piece list. The map REGENERATES from a new
// seed every round, so these rebuild in init()/reset() (after initMap has
// swapped MAP's contents), not once at module load.
let panelById = new Map(MAP.panels.map((p) => [p.id, p]));
let CONTACTS = buildContactIndex();

function rebuildMapIndexes(): void {
  panelById = new Map(MAP.panels.map((p) => [p.id, p]));
  CONTACTS = buildContactIndex();
}

const RELEASE_PIECES_PER_TICK = 80;

// Cap on the CLIENT-attributable rewind (interp delay + transit): 120ms.
// The server's own input-buffer wait is added on top uncapped — that delay
// is ours, not the shooter's ping, and exists even on LAN.
const VIEW_REWIND_CAP_TICKS = Math.round(120 / TICK_MS);

// Destroyed pieces have a chance to leave a chunk of themselves on the
// ground — persistent, collision-real cover that keeps evolving the level
// long after the walls are gone. Chunks ride the existing "build" machinery
// (they're just runtime panels), so clients get body + visual for free, and
// they're destructible in turn (material "rubble", no re-rubble).
const RUBBLE_CHANCE: Partial<Record<PanelMaterial, number>> = {
  brick: 0.38,
  log: 0.6,
  plank: 0.32,
  post: 0.8,
  trunk: 0.65,
  crate: 0.7,
  sandbag: 0.45,
  rock: 0.6,
  concrete: 0.45,
  metal: 0.5,
};
const RUBBLE_CAP = 1200; // mirrors the client's instanced rubble pool

// The entire game state and every gameplay rule, deterministic given the
// seed and the input stream. The server owns connections, input buffering,
// bot decisions, and snapshot encoding around an instance of this class.
export class GameSim {
  gw!: GameWorld;
  tick = 0;
  phase: "playing" | "results" = "playing";
  phaseEndTick = 0;
  readonly scores: [number, number] = [TICKETS_START, TICKETS_START]; // = tickets

  readonly zones: ZoneState[] = ZONES.map(() => ({ owner: -1, v: 0 }));
  private nextBleedTick = 0;

  // Sim players by slot; null slots are empty.
  readonly players: Array<SimPlayer | null> = Array.from({ length: MAX_PLAYERS }, () => null);

  readonly panelHp = new Map<number, number>(); // damaged panels only
  readonly destroyedPanels = new Set<number>();
  readonly builtPanels = new Map<number, PanelDef>();
  readonly collapsedBuildings = new Set<number>();
  private nextBuiltPanelId = BUILT_PANEL_ID_BASE;
  private pendingHpUpdates = new Map<number, number>();
  private pendingDestroys: number[] = [];
  private pendingRubble: PanelDef[] = [];
  // Slabs whose damage set changed this tick — collision rebuilds are batched.
  private readonly dirtySlabs = new Set<number>();
  private readonly pieceAlive = (id: number): boolean => !this.destroyedPanels.has(id);

  grenades: Grenade[] = [];
  private nextGrenadeId = 1;

  readonly falling = new Map<number, FallingChunk>();
  private readonly releasedThisTick: PanelDef[] = [];

  // Set for the duration of one explosion so released pieces inherit a blast
  // impulse and fly outward instead of dropping straight down.
  private blastCtx: { x: number; y: number; z: number; tick: number } | null = null;

  readonly events: GameEvent[] = [];
  private nextEventSeq = 1;
  // All sim randomness comes from here, in deterministic order.
  rng: () => number;

  // Reliable messages produced this tick, in order; the server drains and
  // broadcasts them verbatim.
  readonly outbox: ServerMsg[] = [];

  constructor(seed: number) {
    this.rng = mulberry32(seed);
  }

  async init(): Promise<void> {
    rebuildMapIndexes();
    this.gw = await createGameWorld();
  }

  // --- Players ---------------------------------------------------------------

  player(idx: number): SimPlayer | null {
    return this.players[idx] ?? null;
  }

  addPlayer(slot: number, team: number, classId = 0): SimPlayer {
    const spawn = spawnPoint(team, slot);
    const p: SimPlayer = {
      idx: slot,
      team,
      body: createPlayerBody(this.gw, slot, spawn),
      state: makeChar(spawn, classPrimaryIdx(classId)),
      lastCmd: { seq: 0, ...ZERO_INPUT },
      hp: MAX_HP,
      dead: false,
      history: new PositionHistory(),
      respawnAtTick: 0,
      protectUntilTick: this.tick + PROTECT_TICKS,
      lastDamageTick: 0,
      kills: 0,
      deaths: 0,
      oobSinceTick: -1,
      spawnZone: SPAWN_AUTO,
      classId,
      autoRespawn: true,
      wantsRespawn: false,
    };
    this.players[slot] = p;
    return p;
  }

  removePlayer(slot: number): void {
    if (!this.players[slot]) return;
    removePlayerBody(this.gw, slot);
    this.players[slot] = null;
  }

  // --- Inputs ----------------------------------------------------------------

  // Advance one player's controller with their input for this tick, firing
  // the weapon hooks (hit resolution, grenade spawn, cover placement).
  applyInput(slot: number, cmd: InputCmd, opts: ApplyInputOpts = {}): void {
    const p = this.players[slot];
    if (!p) return;
    p.lastCmd = cmd;
    stepPlayerController(this.gw, p.body, p.state, cmd, {
      locked: opts.locked,
      onFire: (eye, dir) => this.resolveShot(p, eye, dir, opts),
      onMelee: (eye, dir) => this.resolveMelee(p, eye, dir, opts),
      onGrenade: (origin, vel) => {
        const id = this.allocGrenadeId();
        this.grenades.push({
          id,
          ownerIdx: p.idx,
          fuseLeft: GRENADE_FUSE_TICKS,
          body: createGrenadeBody(this.gw, id, origin, vel),
        });
      },
      onBuild: (panel) => this.resolveBuild(p, panel),
    });
  }

  // --- World step ------------------------------------------------------------

  // Everything after inputs, in strict order: queued support releases,
  // grenade fuses, batched collision rebuilds, the physics step, falling
  // chunks, respawns/regen, zone capture, and the destruction flush.
  stepWorld(): void {
    this.drainReleases();
    this.launchReleasedChunks();
    this.stepGrenades();
    this.flushSlabRebuilds();
    this.gw.world.step(1 / TICK_RATE);
    this.stepFalling();
    this.stepLifecycles();
    this.stepZones();
    this.flushDestroys();
  }

  // --- Combat ----------------------------------------------------------------

  private rewoundFeet(q: SimPlayer, rewindTicks: number): readonly number[] | null {
    return q.history.rewound(rewindTicks);
  }

  // Shared lag-compensated hitscan: present-day walls occlude, but player
  // capsules are tested where the shooter SAW them — their input carries the
  // server tick of the world they were rendering (Source-style: rewind =
  // client latency + client interpolation, measured exactly, not assumed).
  private resolveAttack(
    p: SimPlayer,
    eye: [number, number, number],
    d: [number, number, number],
    range: number,
    rewindTicks: number,
  ): AttackHit {
    const wall = castWallDistance(this.gw, eye, d, range);
    let bestT = wall.dist;
    let victim: SimPlayer | null = null;
    let victimFeetY = 0;
    for (const q of this.players) {
      if (!q || q === p || q.dead || q.team === p.team) continue;
      const feet = this.rewoundFeet(q, rewindTicks);
      if (!feet) continue;
      const t = rayVsCapsule(eye, d, bestT, feet);
      if (t !== null && t < bestT) {
        bestT = t;
        victim = q;
        victimFeetY = feet[1];
      }
    }
    if (victim) {
      const point: [number, number, number] = [
        eye[0] + d[0] * bestT,
        eye[1] + d[1] * bestT,
        eye[2] + d[2] * bestT,
      ];
      return {
        victim,
        panelBody: null,
        point,
        headshot: point[1] - victimFeetY >= HEADSHOT_HEIGHT,
      };
    }
    return {
      victim: null,
      panelBody: wall.dist < range ? wall.body : null,
      point: wall.point,
      headshot: false,
    };
  }

  private rewindFor(p: SimPlayer, opts: ApplyInputOpts): number {
    // Bots aim at the live world; humans report what they were rendering.
    if (opts.isBot) return 1;
    const viewTick = unwrapViewTick(p.lastCmd.viewTick, this.tick);
    const bufferWait = Math.max(0, opts.bufferWait ?? 0);
    const clientView = Math.max(0, this.tick - bufferWait - viewTick);
    const rewind = Math.min(clientView, VIEW_REWIND_CAP_TICKS) + bufferWait;
    return Math.max(1, Math.min(HISTORY_TICKS, rewind));
  }

  private resolveShot(
    p: SimPlayer,
    eye: [number, number, number],
    dir: [number, number, number],
    opts: ApplyInputOpts,
  ): void {
    // The dir already carries deterministic recoil (shared controller); the
    // random spread below is server-side only — clients predict the muzzle
    // effect and ammo, never the trajectory.
    const w = activeWeapon(p.state);

    // Bullets leave the BARREL, not the eye — unless the barrel pokes into a
    // wall (eye->muzzle pre-check), which would let shots skip thin cover.
    let origin = eye;
    const mo = muzzleOrigin(p.state, p.lastCmd.yaw, p.lastCmd.pitch);
    const mdx = mo[0] - eye[0];
    const mdy = mo[1] - eye[1];
    const mdz = mo[2] - eye[2];
    const mDist = Math.hypot(mdx, mdy, mdz);
    if (mDist > 1e-4) {
      const toMuzzle: [number, number, number] = [mdx / mDist, mdy / mDist, mdz / mDist];
      if (castWallDistance(this.gw, eye, toMuzzle, mDist).dist >= mDist - 1e-3) origin = mo;
    }

    // The barrel sits off the eye line, and parallel rays never meet it — a
    // shot fired straight along the view direction from the muzzle lands a
    // constant ~0.25m off the crosshair at EVERY range, which a scoped
    // sniper reads as "the bullet didn't go where I aimed". Converge
    // instead: aim the barrel at whatever the EYE ray sees.
    let baseDir = dir;
    if (origin === mo) {
      const aimDist = Math.max(
        2,
        Math.min(w.range, castWallDistance(this.gw, eye, dir, w.range).dist),
      );
      const cx = eye[0] + dir[0] * aimDist - mo[0];
      const cy = eye[1] + dir[1] * aimDist - mo[1];
      const cz = eye[2] + dir[2] * aimDist - mo[2];
      const cl = Math.hypot(cx, cy, cz) || 1;
      baseDir = [cx / cl, cy / cl, cz / cl];
    }

    const rewind = this.rewindFor(p, opts);
    const pellets = w.pellets ?? 1;
    // Caps keep a shotgun blast from flooding the event ring: a few tracers
    // and one hit event per victim still read clearly on every client.
    let tracersLeft = Math.min(pellets, 3);
    let panelHitsLeft = 2;
    // Damage is tallied per victim across the whole blast (one damagePlayer
    // call each) so pellet-count rules like the point-blank kill can apply.
    const victims = new Map<
      SimPlayer,
      { dmg: number; hits: number; point: [number, number, number]; minDistSq: number }
    >();
    for (let i = 0; i < pellets; i++) {
      const spread = spreadFor(p.state, p.lastCmd.crouch);
      const d = perturb(baseDir, (this.rng() - 0.5) * 2 * spread, (this.rng() - 0.5) * 2 * spread);
      const hit = this.resolveAttack(p, origin, d, w.range, rewind);
      if (tracersLeft-- > 0) this.pushEvent(EV_TRACER, p.idx, hit.point);
      if (hit.victim) {
        let tally = victims.get(hit.victim);
        if (!tally) {
          tally = { dmg: 0, hits: 0, point: hit.point, minDistSq: Infinity };
          victims.set(hit.victim, tally);
        }
        tally.dmg += hit.headshot ? Math.round(w.damage * w.headshotMult) : w.damage;
        tally.hits++;
        const dx = hit.point[0] - origin[0];
        const dy = hit.point[1] - origin[1];
        const dz = hit.point[2] - origin[2];
        tally.minDistSq = Math.min(tally.minDistSq, dx * dx + dy * dy + dz * dz);
      } else if (hit.panelBody) {
        const pieceId = pieceIdFromHit(hit.panelBody, hit.point, this.pieceAlive);
        if (pieceId !== null) {
          this.damagePanel(pieceId, w.panelDamage);
          if (panelHitsLeft-- > 0) this.pushEvent(EV_PANEL_HIT, 0, hit.point);
        }
      }
    }
    for (const [victim, tally] of victims) {
      // Point-blank devastation: in your face with ~90% of the pellets on
      // target, a body-shot blast is lethal outright.
      if (
        w.pointBlankRange !== undefined &&
        tally.hits >= Math.round(pellets * 0.9) &&
        tally.minDistSq <= w.pointBlankRange * w.pointBlankRange
      ) {
        tally.dmg = Math.max(tally.dmg, MAX_HP);
      }
      this.damagePlayer(victim, tally.dmg, p, "rifle");
      // a packs victim (low nibble) and shooter (high nibble): idx < 16.
      this.pushEvent(EV_HIT_PLAYER, (victim.idx & 0xf) | ((p.idx & 0xf) << 4), tally.point);
    }
  }

  private resolveMelee(
    p: SimPlayer,
    eye: [number, number, number],
    dir: [number, number, number],
    opts: ApplyInputOpts,
  ): void {
    const hit = this.resolveAttack(p, eye, dir, MELEE_RANGE, this.rewindFor(p, opts));
    this.pushEvent(EV_MELEE, p.idx, hit.point);
    if (hit.victim) {
      this.damagePlayer(hit.victim, MELEE_DAMAGE, p, "melee");
    } else if (hit.panelBody) {
      const pieceId = pieceIdFromHit(hit.panelBody, hit.point, this.pieceAlive);
      if (pieceId !== null) this.damagePanel(pieceId, MELEE_PANEL_DAMAGE);
    }
  }

  private resolveBuild(p: SimPlayer, panel: PanelDef): void {
    // Must sit inside the arena, on support, and away from players.
    const half = MAP.size / 2 - 1;
    const refund = () => {
      p.state.supply++;
    };
    if (Math.abs(panel.x) > half || Math.abs(panel.z) > half) return refund();
    const under = this.gw.world.castRay([panel.x, panel.y, panel.z], [0, -2.2, 0]);
    if (!under) return refund();
    for (const q of this.players) {
      if (!q || q.dead) continue;
      readChar(q.body, q.state);
      if (Math.hypot(q.state.x - panel.x, q.state.z - panel.z) < 1.0) return refund();
    }
    const placed: PanelDef = { ...panel, id: this.nextBuiltPanelId++ };
    addPanelBody(this.gw, placed);
    this.builtPanels.set(placed.id, placed);
    this.outbox.push({ type: "build", panel: placed, byIdx: p.idx });
  }

  private damagePlayer(
    victim: SimPlayer,
    dmg: number,
    attacker: SimPlayer,
    weapon: "rifle" | "grenade" | "melee",
  ): void {
    if (SANDBOX) return;
    if (victim.dead || this.tick < victim.protectUntilTick || this.phase !== "playing") return;
    victim.hp -= dmg;
    victim.lastDamageTick = this.tick;
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.dead = true;
      victim.deaths++;
      victim.respawnAtTick = this.tick + RESPAWN_TICKS;
      if (attacker !== victim) attacker.kills++;
      // Conquest: every death burns a ticket.
      this.scores[victim.team] = Math.max(0, this.scores[victim.team] - 1);
      this.outbox.push({ type: "kill", killer: attacker.idx, victim: victim.idx, weapon });
      // Park the body at the spawn until respawn; clients hide it via RF_DEAD.
      const spawn = spawnPoint(victim.team, victim.idx);
      victim.state = makeChar(spawn, classPrimaryIdx(victim.classId));
      writeChar(victim.body, victim.state);
    }
  }

  // --- Destruction -----------------------------------------------------------

  private markPieceGone(panelId: number): void {
    const slabIdx = slabOfPiece(panelId);
    if (slabIdx >= 0) this.dirtySlabs.add(slabIdx);
  }

  private flushSlabRebuilds(): void {
    for (const slabIdx of this.dirtySlabs) rebuildSlabBody(this.gw, slabIdx, this.pieceAlive);
    this.dirtySlabs.clear();
  }

  // Masonry is bonded: a piece stands while its connected region (through
  // touching alive pieces) still reaches the ground. When a piece dies, flood
  // from each alive neighbor — regions that no longer reach ground are
  // released whole, as one island, and fall as one rigid chunk. Breaking a
  // window drops nothing; carving a seam drops the slab you cut loose.
  private readonly _floodSeen = new Set<number>();

  private cascadeUnsupported(panelId: number): void {
    const neighbors = CONTACTS.adj.get(panelId);
    if (!neighbors) return;
    const safe = new Set<number>(); // verified ground-connected, this event
    for (const n of neighbors) {
      if (this.destroyedPanels.has(n) || safe.has(n)) continue;
      const island = this.floodToGround(n, safe);
      if (island) this.queueRelease(island);
    }
  }

  // BFS through alive contacts. Reaching a grounded (or known-safe) piece
  // marks everything visited as safe and returns null; exhausting the region
  // returns the disconnected island.
  private floodToGround(start: number, safe: Set<number>): number[] | null {
    this._floodSeen.clear();
    this._floodSeen.add(start);
    const stack = [start];
    let i = 0;
    while (i < stack.length) {
      const id = stack[i++];
      if (CONTACTS.grounded.has(id) || safe.has(id)) {
        for (const v of this._floodSeen) safe.add(v);
        return null;
      }
      for (const next of CONTACTS.adj.get(id) ?? []) {
        if (this._floodSeen.has(next) || this.destroyedPanels.has(next)) continue;
        this._floodSeen.add(next);
        stack.push(next);
      }
    }
    return stack;
  }

  // Releases are budgeted per tick, but an island is atomic — it falls as one
  // chunk however big it is.
  private readonly releaseQueue: number[][] = [];

  private queueRelease(island: number[]): void {
    this.releaseQueue.push(island);
  }

  private drainReleases(): void {
    let n = 0;
    while (this.releaseQueue.length > 0 && n < RELEASE_PIECES_PER_TICK) {
      const island = this.releaseQueue.shift()!;
      for (const id of island) {
        if (this.destroyedPanels.has(id)) continue;
        this.releasePiece(id);
        n++;
      }
    }
  }

  // Settled pieces aren't in the static contact graph — when something is
  // destroyed near them, probe whether their perch is gone and re-release the
  // ones left hanging (each as its own one-piece island).
  private recheckSettledNear(x: number, y: number, z: number): void {
    // Snapshot: releasing mutates builtPanels mid-iteration.
    const candidates = [...this.builtPanels];
    for (const [id, def] of candidates) {
      if (Math.abs(def.x - x) > 3 || Math.abs(def.z - z) > 3 || def.y < y - 0.3) continue;
      const halfH = (def.rot ? Math.max(def.ex, def.ey, def.ez) : def.ey) / 2;
      if (def.y - halfH < heightAt(def.x, def.z) + 0.2) continue; // on the ground
      const hit = this.gw.world.castRay([def.x, def.y - halfH - 0.03, def.z], [0, -0.35, 0]);
      if (!hit) this.queueRelease([id]);
    }
  }

  // Retire a still-alive static piece into this tick's release batch. The
  // original id counts toward structure integrity (the wall really did lose
  // it); the surviving piece tumbles inside a rigid chunk and re-enters play
  // when the chunk settles. Glass shatters instead of tumbling.
  private releasePiece(panelId: number): void {
    if (this.destroyedPanels.has(panelId)) return;
    const src = panelById.get(panelId) ?? this.builtPanels.get(panelId);
    if (!src) return;
    if (src.material === "glass" || this.falling.size >= FALLING_CAP) {
      this.destroyPanel(panelId, true);
      return;
    }
    this.destroyedPanels.add(panelId);
    this.panelHp.delete(panelId);
    this.builtPanels.delete(panelId);
    removePanelBody(this.gw, panelId);
    this.markPieceGone(panelId);
    this.pendingDestroys.push(panelId);
    this.releasedThisTick.push({
      id: 0, // assigned when the chunk settles
      x: src.x,
      y: src.y,
      z: src.z,
      ex: src.ex,
      ey: src.ey,
      ez: src.ez,
      material: src.material,
      rot: src.rot,
      seed: src.seed ?? src.id,
    });
    // No re-cascade: islands are computed in full before release, and pieces
    // at the boundary are ground-connected by construction.
  }

  // Group this tick's released pieces into connected clusters (touching
  // AABBs) and launch each as ONE rigid compound body — a wall slab tips over
  // coherently, a tree top topples whole, instead of N bricks rearranging.
  private launchReleasedChunks(): void {
    const batch = this.releasedThisTick.splice(0);
    if (batch.length === 0) return;

    const parent = batch.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const touching = (a: PanelDef, b: PanelDef): boolean =>
      Math.abs(a.x - b.x) - (a.ex + b.ex) / 2 < 0.12 &&
      Math.abs(a.y - b.y) - (a.ey + b.ey) / 2 < 0.12 &&
      Math.abs(a.z - b.z) - (a.ez + b.ez) / 2 < 0.12;
    for (let i = 0; i < batch.length; i++) {
      for (let j = i + 1; j < batch.length; j++) {
        if (find(i) !== find(j) && touching(batch[i], batch[j])) parent[find(j)] = find(i);
      }
    }
    const clusters = new Map<number, PanelDef[]>();
    for (let i = 0; i < batch.length; i++) {
      const root = find(i);
      const list = clusters.get(root);
      if (list) list.push(batch[i]);
      else clusters.set(root, [batch[i]]);
    }

    for (const pieces of clusters.values()) {
      const id = this.nextBuiltPanelId++;
      let ox = 0;
      let oy = 0;
      let oz = 0;
      for (const p of pieces) {
        ox += p.x;
        oy += p.y;
        oz += p.z;
      }
      const origin: [number, number, number] = [
        ox / pieces.length,
        oy / pieces.length,
        oz / pieces.length,
      ];
      // Blast-released chunks fly outward (lighter ones farther);
      // cascade-released ones slump in place.
      let vel: [number, number, number] = [(this.rng() - 0.5) * 0.4, 0, (this.rng() - 0.5) * 0.4];
      if (this.blastCtx && this.blastCtx.tick === this.tick) {
        const dx = origin[0] - this.blastCtx.x;
        const dy = origin[1] - this.blastCtx.y;
        const dz = origin[2] - this.blastCtx.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const kick = Math.min(7, 11 / (1 + d)) / Math.max(1, Math.sqrt(pieces.length / 4));
        vel = [(dx / d) * kick, Math.abs(dy / d) * kick * 0.5 + 1.5, (dz / d) * kick];
      }
      this.falling.set(id, {
        id,
        origin,
        pieces,
        body: createFallingChunkBody(this.gw, id, origin, pieces, vel),
        calmTicks: 0,
        bornTick: this.tick,
      });
      this.outbox.push({ type: "fall", chunkId: id, origin, pieces });
    }
  }

  // Settle check: a chunk that has stopped moving (or timed out) splits back
  // into individual static, destructible pieces at their final poses.
  private stepFalling(): void {
    // Snapshot first: settling mutates the map mid-iteration.
    const active = [...this.falling.values()];
    for (const f of active) {
      const pos = f.body.translation();
      if (pos.y < -3) {
        this.falling.delete(f.id);
        this.gw.world.removeBody(f.body);
        continue;
      }
      const v = f.body.linearVelocity();
      const w = f.body.angularVelocity();
      const calm = Math.hypot(v.x, v.y, v.z) < 0.18 && Math.hypot(w.x, w.y, w.z) < 0.3;
      f.calmTicks = calm ? f.calmTicks + 1 : 0;
      if (f.calmTicks < 8 && this.tick - f.bornTick < FALL_TIMEOUT_TICKS) continue;

      const rot = f.body.rotation();
      this.falling.delete(f.id);
      this.gw.world.removeBody(f.body);
      const qx = rot.x;
      const qy = rot.y;
      const qz = rot.z;
      const qw = rot.w;
      const settled: PanelDef[] = [];
      for (const p of f.pieces) {
        const lx = p.x - f.origin[0];
        const ly = p.y - f.origin[1];
        const lz = p.z - f.origin[2];
        // Quaternion-rotate the local offset into the resting frame.
        const tx = 2 * (qy * lz - qz * ly);
        const ty = 2 * (qz * lx - qx * lz);
        const tz = 2 * (qx * ly - qy * lx);
        const def: PanelDef = {
          id: this.nextBuiltPanelId++,
          x: pos.x + lx + qw * tx + qy * tz - qz * ty,
          y: pos.y + ly + qw * ty + qz * tx - qx * tz,
          z: pos.z + lz + qw * tz + qx * ty - qy * tx,
          ex: p.ex,
          ey: p.ey,
          ez: p.ez,
          material: p.material,
          rot: [qx, qy, qz, qw],
          seed: p.seed,
        };
        if (def.y < -1) continue;
        addPanelBody(this.gw, def);
        this.builtPanels.set(def.id, def);
        settled.push(def);
      }
      this.outbox.push({ type: "settle", chunkId: f.id, pieces: settled });
    }
  }

  private panelMaxHp(panelId: number): number {
    const def = panelById.get(panelId) ?? this.builtPanels.get(panelId);
    return def ? PANEL_HP[def.material] : PANEL_HP.metal;
  }

  private damagePanel(panelId: number, dmg: number): void {
    if (this.destroyedPanels.has(panelId)) return;
    const hp = (this.panelHp.get(panelId) ?? this.panelMaxHp(panelId)) - dmg;
    if (hp <= 0) this.destroyPanel(panelId);
    else {
      this.panelHp.set(panelId, hp);
      this.pendingHpUpdates.set(panelId, hp); // batched per tick for damage tinting
    }
  }

  private destroyPanel(panelId: number, leaveRubble = true): void {
    if (this.destroyedPanels.has(panelId)) return;
    const src = panelById.get(panelId) ?? this.builtPanels.get(panelId);
    const isMapPanel = panelById.has(panelId);
    this.destroyedPanels.add(panelId);
    this.panelHp.delete(panelId);
    this.builtPanels.delete(panelId);
    removePanelBody(this.gw, panelId);
    this.markPieceGone(panelId);
    this.pendingDestroys.push(panelId);
    if (leaveRubble && src) this.maybeLeaveRubble(src);
    if (leaveRubble && isMapPanel) this.cascadeUnsupported(panelId);
    if (leaveRubble && src) this.recheckSettledNear(src.x, src.y, src.z);
    // BattleBit-style critical health: enough wall damage fells the building.
    const buildingId = src?.buildingId;
    if (buildingId !== undefined && !this.collapsedBuildings.has(buildingId)) {
      const b = MAP.buildings[buildingId];
      const gone = b.wallPanelIds.filter((id) => this.destroyedPanels.has(id)).length;
      if (gone >= Math.ceil(b.wallPanelIds.length * b.collapseFraction)) {
        this.collapseBuilding(buildingId);
      }
    }
  }

  private maybeLeaveRubble(src: PanelDef): void {
    if (this.builtPanels.size >= RUBBLE_CAP) return;
    if (this.rng() >= (RUBBLE_CHANCE[src.material] ?? 0)) return;
    // The fragment IS a broken chunk of the destroyed piece: same material and
    // palette, a bite taken out of the original proportions, dropped at the
    // foot of where it died with a random resting yaw.
    const span = Math.max(src.ex, src.ez);
    const x = src.x + (this.rng() - 0.5) * Math.min(1.0, span);
    const z = src.z + (this.rng() - 0.5) * Math.min(1.0, span);
    const ey = src.ey * (0.8 + this.rng() * 0.2);
    const yaw = this.rng() * Math.PI;
    const def: PanelDef = {
      id: this.nextBuiltPanelId++,
      x,
      y: heightAt(x, z) + ey * 0.45,
      z,
      ex: src.ex * (0.4 + this.rng() * 0.3),
      ey,
      ez: src.ez * (0.75 + this.rng() * 0.25),
      material: src.material,
      rot: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
      seed: src.seed ?? src.id,
      broken: true,
    };
    addPanelBody(this.gw, def);
    this.builtPanels.set(def.id, def);
    this.pendingRubble.push(def); // batched into one "rubble" message per tick
  }

  private collapseBuilding(buildingId: number): void {
    this.collapsedBuildings.add(buildingId); // before the cascade, so it can't recurse
    const b = MAP.buildings[buildingId];
    this.outbox.push({ type: "collapse", buildingId });
    if (b.kind === "tree") {
      // The rest of the tree topples: every still-standing piece is released
      // intact and lands wherever physics takes it.
      for (const id of [...b.wallPanelIds, ...b.roofPanelIds]) this.releasePiece(id);
      return;
    }
    // Buildings implode: the dramatic full-structure drop with a rubble mound.
    for (const id of [...b.wallPanelIds, ...b.roofPanelIds]) this.destroyPanel(id, false);
    addRubbleBody(this.gw, b, RUBBLE_HEIGHT);
  }

  private flushDestroys(): void {
    if (this.pendingHpUpdates.size > 0) {
      this.outbox.push({ type: "panelhp", updates: [...this.pendingHpUpdates.entries()] });
      this.pendingHpUpdates = new Map();
    }
    if (this.pendingRubble.length > 0) {
      this.outbox.push({ type: "rubble", panels: this.pendingRubble });
      this.pendingRubble = [];
    }
    if (this.pendingDestroys.length === 0) return;
    this.outbox.push({ type: "destroy", panelIds: this.pendingDestroys });
    this.pendingDestroys = [];
  }

  // --- Grenades ----------------------------------------------------------------

  private allocGrenadeId(): number {
    for (let i = 0; i < 256; i++) {
      const id = this.nextGrenadeId++ & 0xff;
      if (!this.grenades.some((g) => g.id === id)) return id;
    }
    return this.nextGrenadeId & 0xff;
  }

  private stepGrenades(): void {
    for (const g of this.grenades.slice()) {
      g.fuseLeft--;
      if (g.fuseLeft > 0) continue;
      const pos = g.body.translation();
      removeGrenadeBody(this.gw, g.id);
      this.grenades = this.grenades.filter((x) => x !== g);
      this.explode([pos.x, pos.y, pos.z], g.ownerIdx);
    }
  }

  private explode(at: [number, number, number], ownerIdx: number): void {
    this.pushEvent(EV_EXPLOSION, 0, at);
    this.blastCtx = { x: at[0], y: at[1], z: at[2], tick: this.tick };
    const owner = this.player(ownerIdx);

    // Players: radial damage (friendly fire off, self damage on) + impulse.
    for (const p of this.players) {
      if (!p || p.dead) continue;
      readChar(p.body, p.state);
      const dx = p.state.x - at[0];
      const dy = p.state.y + PLAYER_HALF_HEIGHT - at[1];
      const dz = p.state.z - at[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > EXPLOSION_RADIUS) continue;
      const falloff = 1 - dist / EXPLOSION_RADIUS;
      const friendly = owner !== null && p.team === owner.team && p.idx !== ownerIdx;
      if (!friendly && owner) {
        const dmg = EXPLOSION_MIN_DAMAGE + (EXPLOSION_MAX_DAMAGE - EXPLOSION_MIN_DAMAGE) * falloff;
        this.damagePlayer(p, Math.round(dmg), owner, "grenade");
      }
      if (!p.dead) {
        const n = dist > 0.01 ? 1 / dist : 0;
        const kick = EXPLOSION_IMPULSE * falloff;
        p.body.setLinearVelocity(
          p.state.vx + dx * n * kick,
          p.state.vy + Math.max(3, dy * n * kick + 4),
          p.state.vz + dz * n * kick,
        );
      }
    }

    // Terrain: a ground-level blast digs a crater (dug BEFORE the panel pass so
    // freshly shed rubble settles into the new bowl). Clients get the crater on
    // the reliable stream and rebuild the same tiles.
    if (at[1] - heightAt(at[0], at[2]) < 1.6) {
      const crater: Crater = { x: at[0], z: at[2], r: 2.6, d: 0.85 };
      addCrater(crater);
      applyCraterBodies(this.gw, crater);
      this.outbox.push({ type: "crater", crater });
    }

    // Panels: deleted outright up close, chipped in an outer falloff ring.
    // Staircases are blast-exempt so floors stay reachable through bombardment.
    const blastPanel = (id: number, px: number, py: number, pz: number) => {
      if ((panelById.get(id) ?? this.builtPanels.get(id))?.material === "stair") return;
      const dist = Math.hypot(px - at[0], py - at[1], pz - at[2]);
      if (dist <= EXPLOSION_PANEL_RADIUS) this.destroyPanel(id);
      else if (dist <= EXPLOSION_PANEL_OUTER_RADIUS) {
        this.damagePanel(id, EXPLOSION_PANEL_OUTER_DAMAGE);
      }
    };
    for (const p of MAP.panels) {
      if (!this.destroyedPanels.has(p.id)) blastPanel(p.id, p.x, p.y, p.z);
    }
    // Snapshot first: blast-destroyed pieces shed rubble INTO builtPanels
    // mid-loop, and freshly shed chunks shouldn't be vaporized by the same
    // blast that created them.
    const preBlast = [...this.builtPanels];
    for (const [id, p] of preBlast) blastPanel(id, p.x, p.y, p.z);

    // Other grenades get knocked around.
    for (const g of this.grenades) {
      const pos = g.body.translation();
      const dist = Math.hypot(pos.x - at[0], pos.y - at[1], pos.z - at[2]);
      if (dist < EXPLOSION_RADIUS && dist > 0.01) {
        const kick = (EXPLOSION_IMPULSE * (1 - dist / EXPLOSION_RADIUS)) / dist;
        const vel = g.body.linearVelocity();
        g.body.setLinearVelocity(
          vel.x + (pos.x - at[0]) * kick,
          vel.y + (pos.y - at[1]) * kick + 2,
          vel.z + (pos.z - at[2]) * kick,
        );
      }
    }
  }

  // --- Lifecycle ------------------------------------------------------------------

  private stepLifecycles(): void {
    for (const p of this.players) {
      if (!p) continue;
      readChar(p.body, p.state);
      p.history.push(p.state.x, p.state.y, p.state.z);
      if (p.dead) p.history.clear(); // don't rewind into a corpse

      if (
        p.dead &&
        this.tick >= p.respawnAtTick &&
        this.phase === "playing" &&
        (p.autoRespawn || p.wantsRespawn)
      ) {
        const spawn = this.chooseSpawn(p);
        p.state = makeChar(spawn, classPrimaryIdx(p.classId));
        writeChar(p.body, p.state);
        p.hp = MAX_HP;
        p.dead = false;
        p.wantsRespawn = false;
        p.protectUntilTick = this.tick + PROTECT_TICKS;
        p.oobSinceTick = -1;
      }
      // Out of bounds: no perimeter walls, so straying past the play boundary
      // starts a countdown; not returning in time is fatal.
      if (p.dead || this.phase !== "playing") {
        p.oobSinceTick = -1;
      } else {
        // Past the play boundary OR camping inside the enemy's home bowl —
        // both start the return-or-die countdown.
        const oob =
          Math.abs(p.state.x) > PLAY_HALF ||
          Math.abs(p.state.z) > PLAY_HALF ||
          inEnemyBase(p.team, p.state.x, p.state.z);
        if (!oob) {
          p.oobSinceTick = -1;
        } else if (p.oobSinceTick < 0) {
          p.oobSinceTick = this.tick;
        } else if (this.tick - p.oobSinceTick >= OOB_LIMIT_TICKS) {
          this.killOutOfBounds(p);
        }
      }
      if (!p.dead && p.hp < MAX_HP && this.tick - p.lastDamageTick > REGEN_DELAY_TICKS) {
        p.hp = Math.min(MAX_HP, p.hp + REGEN_PER_TICK);
      }
    }
  }

  // A deserter who didn't return to the battlefield in time. Counts as a death
  // (burns a ticket) like any other.
  private killOutOfBounds(p: SimPlayer): void {
    p.hp = 0;
    p.dead = true;
    p.deaths++;
    p.oobSinceTick = -1;
    p.respawnAtTick = this.tick + RESPAWN_TICKS;
    this.scores[p.team] = Math.max(0, this.scores[p.team] - 1);
    this.outbox.push({ type: "kill", killer: p.idx, victim: p.idx, weapon: "oob" });
    const spawn = spawnPoint(p.team, p.idx);
    p.state = makeChar(spawn, classPrimaryIdx(p.classId));
    writeChar(p.body, p.state);
  }

  private stepZones(): void {
    if (this.phase !== "playing") return;
    for (let i = 0; i < ZONES.length; i++) {
      const def = ZONES[i];
      const zn = this.zones[i];
      let c0 = 0;
      let c1 = 0;
      for (const p of this.players) {
        if (!p || p.dead) continue;
        if (Math.hypot(p.state.x - def.x, p.state.z - def.z) > def.r) continue;
        if (p.team === 0) c0++;
        else c1++;
      }
      const net = Math.max(-3, Math.min(3, c1 - c0));
      if (net !== 0) {
        zn.v = Math.max(-100, Math.min(100, zn.v + net * ZONE_CAP_RATE));
      } else if (c0 === 0 && c1 === 0 && zn.owner === -1 && zn.v !== 0) {
        // Abandoned half-captures drift back to neutral.
        zn.v += zn.v > 0 ? -0.1 : 0.1;
        if (Math.abs(zn.v) < 0.15) zn.v = 0;
      }
      if (zn.owner === 0 && zn.v >= 0) zn.owner = -1;
      if (zn.owner === 1 && zn.v <= 0) zn.owner = -1;
      if (zn.v <= -100) zn.owner = 0;
      if (zn.v >= 100) zn.owner = 1;
    }

    // Majority bleed: holding more flags drains the other side's tickets.
    if (this.tick >= this.nextBleedTick) {
      this.nextBleedTick = this.tick + BLEED_INTERVAL_TICKS;
      const owned0 = this.zones.filter((z) => z.owner === 0).length;
      const owned1 = this.zones.filter((z) => z.owner === 1).length;
      if (owned0 > owned1) this.scores[1] = Math.max(0, this.scores[1] - (owned0 - owned1));
      else if (owned1 > owned0) this.scores[0] = Math.max(0, this.scores[0] - (owned1 - owned0));
    }
  }

  // Deploy request from a dead human: spawn as soon as the timer allows.
  requestDeploy(idx: number): void {
    const p = this.players[idx];
    if (p && p.dead) p.wantsRespawn = true;
  }

  // Class pick: takes effect at the next spawn. Like the spawn pick, a choice
  // made while still untouched on the join pad re-kits the player in place.
  setClass(idx: number, classId: number): void {
    const p = this.players[idx];
    if (!p) return;
    if (!Number.isInteger(classId) || classId < 0 || classId >= CLASSES.length) return;
    p.classId = classId;
    if (!p.dead && p.hp === MAX_HP && this.phase === "playing") {
      const base = spawnPoint(p.team, p.idx);
      if (Math.hypot(p.state.x - base[0], p.state.z - base[2]) < 2.5) {
        const primary = classPrimaryIdx(classId);
        p.state.primary = primary;
        p.state.slot = 0;
        p.state.ammo = weaponByIdx(primary).mag;
        p.state.reloadTicks = 0;
        p.state.recoilTicks = 0;
      }
    }
  }

  // Requested respawn point for a player, validated live at spawn time.
  setSpawnZone(idx: number, zone: number): void {
    const p = this.players[idx];
    if (!p) return;
    if (!Number.isInteger(zone) || zone < SPAWN_HQ || zone >= ZONES.length) return;
    p.spawnZone = zone;
    // A pick made on the deploy screen: the player is still untouched on the
    // join pad, so this is a pre-battle choice — move them there right away
    // (joins spawn at the base before the client can ask for anything else).
    const held = zone >= 0 && this.zones[zone].owner === p.team;
    if ((held || zone === SPAWN_HQ) && !p.dead && p.hp === MAX_HP && this.phase === "playing") {
      const base = spawnPoint(p.team, p.idx);
      if (Math.hypot(p.state.x - base[0], p.state.z - base[2]) < 2.5) {
        p.state = makeChar(this.chooseSpawn(p), classPrimaryIdx(p.classId));
        writeChar(p.body, p.state);
        p.history.clear(); // don't lag-comp rewind across the map
        p.protectUntilTick = this.tick + PROTECT_TICKS;
      }
    }
  }

  // Conquest spawning: the player's chosen flag while their team holds it
  // (their call — hot or not, spawn protection covers the landing), their
  // base on request, else auto: the base or a random safely-held zone.
  private chooseSpawn(p: SimPlayer): [number, number, number] {
    const team = p.team;
    if (p.spawnZone >= 0 && p.spawnZone < ZONES.length) {
      if (this.zones[p.spawnZone].owner === team) {
        return this.spawnAroundZone(p.spawnZone);
      }
      // The flag fell while they were down: auto below.
    } else if (p.spawnZone === SPAWN_HQ) {
      return spawnPoint(team, p.idx);
    }
    const safe: number[] = [];
    for (let i = 0; i < ZONES.length; i++) {
      if (this.zones[i].owner !== team) continue;
      const def = ZONES[i];
      let hot = false;
      for (const q of this.players) {
        if (
          q !== null &&
          q.team !== team &&
          !q.dead &&
          Math.hypot(q.state.x - def.x, q.state.z - def.z) < def.r + 8
        ) {
          hot = true;
          break;
        }
      }
      if (!hot) safe.push(i);
    }
    if (safe.length === 0 || this.rng() < 0.35) return spawnPoint(team, p.idx);
    return this.spawnAroundZone(safe[Math.floor(this.rng() * safe.length)]);
  }

  private spawnAroundZone(zoneIdx: number): [number, number, number] {
    const def = ZONES[zoneIdx];
    const ang = this.rng() * Math.PI * 2;
    const x = def.x + Math.sin(ang) * 7;
    const z = def.z + Math.cos(ang) * 7;
    return [x, heightAt(x, z) + 0.1, z];
  }

  // --- Round reset ----------------------------------------------------------------

  async reset(): Promise<void> {
    destroyGameWorld(this.gw);
    this.falling.clear();
    this.releasedThisTick.length = 0;
    this.releaseQueue.length = 0;
    this.dirtySlabs.clear();
    resetCraters();
    rebuildMapIndexes(); // the server re-seeds the map (initMap) before reset
    this.gw = await createGameWorld();
    this.panelHp.clear();
    this.destroyedPanels.clear();
    this.builtPanels.clear();
    this.collapsedBuildings.clear();
    this.pendingHpUpdates = new Map();
    this.pendingDestroys = [];
    this.grenades = [];
    this.scores[0] = TICKETS_START;
    this.scores[1] = TICKETS_START;
    for (const zn of this.zones) {
      zn.owner = -1;
      zn.v = 0;
    }
    this.nextBleedTick = 0;
    this.rng = mulberry32((this.tick * 2654435761) >>> 0 || 1);
    for (const p of this.players) {
      if (!p) continue;
      const spawn = spawnPoint(p.team, p.idx);
      p.body = createPlayerBody(this.gw, p.idx, spawn);
      p.state = makeChar(spawn, classPrimaryIdx(p.classId));
      p.lastCmd = { seq: 0, ...ZERO_INPUT };
      p.hp = MAX_HP;
      p.dead = false;
      p.wantsRespawn = false;
      p.kills = 0;
      p.deaths = 0;
      p.protectUntilTick = this.tick + PROTECT_TICKS;
    }
    this.phase = "playing";
    this.phaseEndTick = this.tick + ROUND_TICKS;
  }

  // --- Events ---------------------------------------------------------------------

  private pushEvent(kind: number, a: number, point: readonly number[]): void {
    this.events.push({
      seq: this.nextEventSeq++ & 0xffff,
      kind,
      a,
      x: point[0],
      y: point[1],
      z: point[2],
    });
    if (this.events.length > EVENT_RING) this.events.shift();
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
