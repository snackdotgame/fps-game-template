// Authoritative FPS server. One Jolt world stepped at the tick rate; players
// are dynamic capsules driven by the shared controller, which fires weapon
// hooks resolved here: hitscan raycasts, sledgehammer swings, grenade bodies,
// and cover deployment. Destruction is server-authoritative — panels lose HP
// to gunfire and melee, explosions delete them in a radius — and propagates
// over reliable streams, while transient effects (tracers, impacts,
// explosions) ride a ring of recent events inside the idempotent snapshots.

import { type Connection, server } from "minion:server";
import {
  BOT_FILL,
  SANDBOX,
  EXPLOSION_IMPULSE,
  EXPLOSION_MAX_DAMAGE,
  EXPLOSION_MIN_DAMAGE,
  EXPLOSION_PANEL_RADIUS,
  EXPLOSION_RADIUS,
  GRENADE_FUSE_TICKS,
  MAX_HP,
  MAX_PLAYERS,
  MELEE_DAMAGE,
  MELEE_PANEL_DAMAGE,
  MELEE_RANGE,
  PROTECT_TICKS,
  REGEN_DELAY_TICKS,
  REGEN_PER_TICK,
  RESPAWN_TICKS,
  RESULTS_TICKS,
  RIFLE_DAMAGE,
  RIFLE_PANEL_DAMAGE,
  RIFLE_RANGE,
  ROUND_TICKS,
  SCORE_LIMIT,
  TICK_MS,
  TICK_RATE,
} from "./shared/constants.js";
import {
  addCrater,
  BUILT_PANEL_ID_BASE,
  buildContactIndex,
  type Crater,
  craterList,
  heightAt,
  MAP,
  PANEL_HP,
  type PanelDef,
  type PanelMaterial,
  resetCraters,
  slabOfPiece,
  spawnPoint,
} from "./shared/map.js";
import {
  EXPLOSION_PANEL_OUTER_DAMAGE,
  EXPLOSION_PANEL_OUTER_RADIUS,
  RUBBLE_HEIGHT,
} from "./shared/constants.js";
import { type PlayerInfo, type ServerMsg } from "./shared/messages.js";
import {
  decodeInputs,
  encodeSnapshot,
  unwrapViewTick,
  type ChunkSnap,
  type EntitySnap,
  EV_EXPLOSION,
  EV_HIT_PLAYER,
  EV_MELEE,
  EV_PANEL_HIT,
  EV_TRACER,
  type GameEvent,
  type RemoteSnap,
  RF_DEAD,
  RF_GROUND,
  RF_PROTECTED,
  RF_RELOADING,
  RF_SPRINT,
  RF_TEAM,
  SS_DEAD,
  SS_PROTECTED,
} from "./shared/netCodec.js";
import {
  addPanelBody,
  addRubbleBody,
  aimDirection,
  applyCraterBodies,
  type Body,
  createGameWorld,
  createGrenadeBody,
  createPlayerBody,
  destroyGameWorld,
  eyePosition,
  type GameWorld,
  type InputCmd,
  joltModule,
  makeChar,
  castWallDistance,
  createFallingChunkBody,
  pieceIdFromHit,
  rebuildSlabBody,
  PLAYER_HALF_HEIGHT,
  rayVsCapsule,
  readChar,
  removeGrenadeBody,
  removePanelBody,
  removePlayerBody,
  spreadFor,
  stepPlayerController,
  writeChar,
  ZERO_INPUT,
  type CharState,
} from "./shared/physics.js";

// The Minion runtime provides console/performance; the DOM-less lib doesn't type them.
declare const console: { log(...args: unknown[]): void };

const MAX_BUFFERED_INPUTS = 90;
const EVENT_RING = 12;
const PARK_TTL_MS = 5 * 60 * 1000;

// A bot's standing decisions; null for humans.
interface BotBrain {
  wanderX: number;
  wanderZ: number;
  repathAtTick: number;
  targetIdx: number; // -1 when no enemy in sight
  burstUntil: number;
  pauseUntil: number;
  aimYaw: number;
  aimPitch: number;
  strafeSign: number;
  strafeFlipAt: number;
  stuckX: number;
  stuckZ: number;
  stuckCheckAt: number;
  grenadeReadyAt: number;
}

interface Player {
  conn: Connection | null; // null = bot
  bot: BotBrain | null;
  idx: number;
  userId: string;
  name: string;
  team: number;
  body: Body;
  state: CharState;
  pending: Map<number, InputCmd>;
  arrivalTicks: Map<number, number>; // seq -> tick the input arrived
  lastCmd: InputCmd;
  lastSeq: number;
  lastSeqTick: number;
  lastArrivalTick: number; // when the applied input ARRIVED (buffer wait = apply - arrival)
  lastDepth: number;
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
}

interface Grenade {
  id: number;
  ownerIdx: number;
  fuseLeft: number;
  body: Body;
}

interface Parked {
  team: number;
  kills: number;
  deaths: number;
  expiresAt: number;
}

// --- Global state ------------------------------------------------------------

let gw: GameWorld;
let tick = 0;
let phase: "playing" | "results" = "playing";
let phaseEndTick = 0;
let mapEpoch = 1;

const players = new Map<string, Player>(); // by connection id, or "bot:<n>"
const parked = new Map<string, Parked>();
let nextBotSerial = 0;
const BOT_NAMES = ["Ash", "Brick", "Castle", "Dune", "Echo", "Flint", "Gravel", "Hatch"];
const scores: [number, number] = [0, 0];

const panelHp = new Map<number, number>(); // damaged panels only
const pieceAlive = (id: number): boolean => !destroyedPanels.has(id);
// Slabs whose damage set changed this tick — collision rebuilds are batched.
const dirtySlabs = new Set<number>();

function markPieceGone(panelId: number): void {
  if (panelId < BUILT_PANEL_ID_BASE) {
    const slabIdx = slabOfPiece(panelId);
    if (slabIdx >= 0) dirtySlabs.add(slabIdx);
  }
}

function flushSlabRebuilds(): void {
  for (const slabIdx of dirtySlabs) rebuildSlabBody(gw, slabIdx, pieceAlive);
  dirtySlabs.clear();
}
const collapsedBuildings = new Set<number>();
let pendingHpUpdates = new Map<number, number>();
const destroyedPanels = new Set<number>();
const builtPanels = new Map<number, PanelDef>();
let nextBuiltPanelId = BUILT_PANEL_ID_BASE;
let pendingDestroys: number[] = [];

let grenades: Grenade[] = [];
let nextGrenadeId = 1;

// Pieces released by the support cascade: intact, dynamic, tumbling under
// the server's sim until they settle and re-freeze as static pieces.
interface FallingChunk {
  id: number;
  origin: [number, number, number];
  pieces: PanelDef[]; // world-space defs at release time; local = piece - origin
  body: Body;
  calmTicks: number;
  bornTick: number;
}

const falling = new Map<number, FallingChunk>();
const releasedThisTick: PanelDef[] = [];
const FALLING_CAP = 24; // concurrent chunks (each may hold dozens of pieces)
const FALL_TIMEOUT_TICKS = 6 * TICK_RATE;

// Set for the duration of one explosion so released pieces inherit a blast
// impulse and fly outward instead of dropping straight down.
let blastCtx: { x: number; y: number; z: number; tick: number } | null = null;

const events: GameEvent[] = [];
let nextEventSeq = 1;
let rng = mulberry32(0xbeac4);

export async function main() {
  await joltModule();
  gw = await createGameWorld();
  phaseEndTick = ROUND_TICKS;

  // Clients never send stream messages; a stream recv settling is the
  // shutdown signal (it rejects when the runtime stops this module).
  let stopped = false;
  const stopSignal = server.streams
    .recv()
    .catch(() => {})
    .then(() => {
      stopped = true;
    });

  let nextTickAt = server.elapsedMs() + TICK_MS;
  while (server.running && !stopped) {
    const wait = nextTickAt - server.elapsedMs();
    await Promise.race([server.sleep(Math.max(1, wait)), stopSignal]);
    if (!server.running || stopped) break;
    nextTickAt += TICK_MS;
    if (server.elapsedMs() > nextTickAt + 10 * TICK_MS) {
      nextTickAt = server.elapsedMs() + TICK_MS;
    }
    await stepServer();
  }
}

let perfInputMs = 0;
let perfStepMs = 0;
let perfSnapMs = 0;
let perfTotalMs = 0;
let perfWorstMs = 0;
let perfTicks = 0;

async function stepServer(): Promise<void> {
  const t0 = server.elapsedMs();
  tick++;
  syncConnections();
  drainInputs();

  for (const p of players.values()) applyPlayerInput(p);
  const t1 = server.elapsedMs();

  drainReleases();
  launchReleasedChunks();
  stepGrenades();
  flushSlabRebuilds();
  gw.world.step(1 / TICK_RATE);
  stepFalling();
  const t2 = server.elapsedMs();

  stepLifecycles();
  flushDestroys();
  await stepPhase();
  broadcastSnapshots();
  const t3 = server.elapsedMs();

  perfInputMs += t1 - t0;
  perfStepMs += t2 - t1;
  perfSnapMs += t3 - t2;
  perfTotalMs += t3 - t0;
  if (t3 - t0 > perfWorstMs) perfWorstMs = t3 - t0;
  perfTicks++;
  if (perfTicks >= 300) {
    // Stay silent while healthy; speak up when the tick budget is threatened.
    const avg = perfTotalMs / perfTicks;
    if (avg > 5 || perfWorstMs > 25) {
      console.log(
        `[perf] tick avg=${(perfTotalMs / perfTicks).toFixed(2)}ms worst=${perfWorstMs.toFixed(1)}ms ` +
          `(input+bots=${(perfInputMs / perfTicks).toFixed(2)} physics=${(perfStepMs / perfTicks).toFixed(2)} ` +
          `out=${(perfSnapMs / perfTicks).toFixed(2)}) players=${players.size}`,
      );
    }
    perfInputMs = perfStepMs = perfSnapMs = perfTotalMs = perfWorstMs = 0;
    perfTicks = 0;
  }
}

// --- Connections ---------------------------------------------------------------

function syncConnections(): void {
  const live = new Set<string>();
  for (const conn of server.connections) {
    live.add(conn.id);
    if (!players.has(conn.id)) addPlayer(conn);
  }
  for (const [connId, p] of players) {
    if (!p.conn) continue; // bots aren't reaped here
    if (!live.has(connId)) removePlayer(connId, p);
  }
  syncBots();
  if (parked.size > 0) {
    const now = server.elapsedMs();
    for (const [userId, park] of parked) {
      if (park.expiresAt < now) parked.delete(userId);
    }
  }
}

function teamCounts(): [number, number] {
  let a = 0;
  let b = 0;
  for (const p of players.values()) {
    if (p.team === 0) a++;
    else b++;
  }
  return [a, b];
}

// --- Bots: fill the lobby, leave one-for-one as humans join. -------------------

function syncBots(): void {
  if (SANDBOX) return;
  let humans = 0;
  let bots = 0;
  for (const p of players.values()) {
    if (p.bot) bots++;
    else humans++;
  }
  const desired = Math.max(0, Math.min(BOT_FILL - humans, MAX_PLAYERS - humans));
  while (bots < desired) {
    addBot();
    bots++;
  }
  while (bots > desired) {
    // Trim from the larger team to keep the match balanced.
    const [a, b] = teamCounts();
    const fromTeam = a >= b ? 0 : 1;
    const entry =
      [...players.entries()].find(([, q]) => q.bot && q.team === fromTeam) ??
      [...players.entries()].find(([, q]) => q.bot);
    if (!entry) break;
    removeBot(entry[0]);
    bots--;
  }
}

function addBot(): void {
  const usedIdx = new Set([...players.values()].map((p) => p.idx));
  let idx = 0;
  while (usedIdx.has(idx)) idx++;
  const [a, b] = teamCounts();
  const team = a <= b ? 0 : 1;
  const serial = nextBotSerial++;
  const name = `BOT ${BOT_NAMES[serial % BOT_NAMES.length]}`;
  const spawn = spawnPoint(team, idx);
  const p: Player = {
    conn: null,
    bot: {
      wanderX: 0,
      wanderZ: 0,
      repathAtTick: 0,
      targetIdx: -1,
      burstUntil: 0,
      pauseUntil: 0,
      aimYaw: 0,
      aimPitch: 0,
      strafeSign: 1,
      strafeFlipAt: 0,
      stuckX: spawn[0],
      stuckZ: spawn[2],
      stuckCheckAt: tick + 45,
      grenadeReadyAt: tick + 300,
    },
    idx,
    userId: `bot:${serial}`,
    name,
    team,
    body: createPlayerBody(gw, idx, spawn),
    state: makeChar(spawn),
    pending: new Map(),
    arrivalTicks: new Map(),
    lastCmd: { seq: 0, ...ZERO_INPUT },
    lastSeq: 0,
    lastSeqTick: tick,
    lastArrivalTick: tick,
    lastDepth: 0,
    hp: MAX_HP,
    dead: false,
    history: new PositionHistory(),
    respawnAtTick: 0,
    protectUntilTick: tick + PROTECT_TICKS,
    lastDamageTick: 0,
    kills: 0,
    deaths: 0,
  };
  players.set(`bot:${serial}`, p);
  broadcast({ type: "join", player: { idx: p.idx, name: p.name, team: p.team } });
}

function removeBot(key: string): void {
  const p = players.get(key);
  if (!p) return;
  players.delete(key);
  removePlayerBody(gw, p.idx);
  broadcast({ type: "leave", idx: p.idx });
}

// One decision pass per tick. Bots play through the same controller and
// weapon hooks as humans — their shots, grenades, and wall-breaching are the
// real thing, just driven by a synthetic InputCmd.
function botThink(p: Player, b: BotBrain): InputCmd {
  readChar(p.body, p.state);
  const s = p.state;
  const eye = eyePosition(s);

  // --- Acquire / validate a target (LoS checked with a real raycast). ---
  if (tick % 5 === 0 || b.targetIdx >= 0) {
    const current = b.targetIdx >= 0 ? playerByIdx(b.targetIdx) : undefined;
    if (!current || current.dead || !hasLineOfSight(p, current)) {
      b.targetIdx = -1;
      if (tick % 5 === 0) {
        let bestDist = 42;
        for (const q of players.values()) {
          if (q.team === p.team || q.dead) continue;
          readChar(q.body, q.state);
          const d = Math.hypot(q.state.x - s.x, q.state.z - s.z);
          if (d < bestDist && hasLineOfSight(p, q)) {
            bestDist = d;
            b.targetIdx = q.idx;
          }
        }
      }
    }
  }

  let moveX = 0;
  let moveZ = 0;
  let fire = false;
  let melee = false;
  let jump = false;
  let grenade = false;
  let reload = false;
  let sprint = false;
  let desiredYaw = b.aimYaw;
  let desiredPitch = 0;

  const target = b.targetIdx >= 0 ? playerByIdx(b.targetIdx) : undefined;
  if (target && !target.dead) {
    const dx = target.state.x - s.x;
    const dz = target.state.z - s.z;
    const dist = Math.hypot(dx, dz);
    // Aim at the chest with distance-scaled wobble.
    const wobble = 0.012 + dist * 0.0011;
    desiredYaw = Math.atan2(dx, dz) + (rng() - 0.5) * 2 * wobble;
    desiredPitch = Math.atan2(target.state.y + 1.0 - eye[1], dist) + (rng() - 0.5) * wobble;
    // Burst fire when roughly on target.
    if (tick >= b.pauseUntil && b.burstUntil <= tick) {
      b.burstUntil = tick + 6 + Math.floor(rng() * 8);
      b.pauseUntil = b.burstUntil + 5 + Math.floor(rng() * 10);
    }
    const aligned = Math.abs(shortestArc(b.aimYaw, desiredYaw)) < 0.07;
    fire = aligned && tick < b.burstUntil;
    // Strafe around the target, keeping medium range.
    if (tick >= b.strafeFlipAt) {
      b.strafeSign = rng() < 0.5 ? -1 : 1;
      b.strafeFlipAt = tick + 25 + Math.floor(rng() * 40);
    }
    const nx = dx / (dist || 1);
    const nz = dz / (dist || 1);
    moveX = -nz * b.strafeSign;
    moveZ = nx * b.strafeSign;
    if (dist > 22) {
      moveX += nx * 0.8;
      moveZ += nz * 0.8;
    } else if (dist < 7) {
      moveX -= nx * 0.8;
      moveZ -= nz * 0.8;
    }
    if (rng() < 0.008) jump = true;
    if (dist > 9 && dist < 26 && tick >= b.grenadeReadyAt && s.grenades > 0 && rng() < 0.012) {
      grenade = true;
      b.grenadeReadyAt = tick + 900;
    }
  } else {
    // Wander between random points; sprint there; reload while safe.
    const toX = b.wanderX - s.x;
    const toZ = b.wanderZ - s.z;
    if (tick >= b.repathAtTick || Math.hypot(toX, toZ) < 2) {
      const half = MAP.size / 2 - 6;
      b.wanderX = (rng() * 2 - 1) * half;
      b.wanderZ = (rng() * 2 - 1) * half;
      // Don't camp the enemy spawn zone — keep the fight in the field.
      const enemySpawnZ = p.team === 0 ? 35 : -35;
      if (Math.abs(b.wanderZ - enemySpawnZ) < 13 && Math.abs(b.wanderX) < 13) {
        b.wanderZ = enemySpawnZ - Math.sign(enemySpawnZ) * (14 + rng() * 10);
      }
      b.repathAtTick = tick + 240 + Math.floor(rng() * 240);
    }
    const len = Math.hypot(toX, toZ) || 1;
    moveX = toX / len;
    moveZ = toZ / len;
    desiredYaw = Math.atan2(moveX, moveZ);
    sprint = true;
    if (s.ammo < 12) reload = true;
  }

  // --- Stuck? Sledge through whatever wall is in the way, BattleBit style. ---
  if (tick >= b.stuckCheckAt) {
    const moved = Math.hypot(s.x - b.stuckX, s.z - b.stuckZ);
    if (moved < 0.5 && !p.dead && (moveX !== 0 || moveZ !== 0)) {
      const dir = aimDirection(b.aimYaw, 0);
      const ahead = gw.world.castRay(
        [eye[0], eye[1] - 0.5, eye[2]],
        [dir[0] * 1.8, 0, dir[2] * 1.8],
      );
      const tag = (ahead?.body?.userData ?? {}) as { panelId?: number; slabIdx?: number };
      if (tag.panelId !== undefined || tag.slabIdx !== undefined) melee = true;
      else jump = true;
      if (rng() < 0.3) b.repathAtTick = 0; // sometimes just go somewhere else
    }
    b.stuckX = s.x;
    b.stuckZ = s.z;
    b.stuckCheckAt = tick + 45;
  }

  // Turn toward the desired view at a finite speed so bots feel human-ish.
  const turn = 0.22; // rad/tick (~6.6 rad/s)
  b.aimYaw += Math.max(-turn, Math.min(turn, shortestArc(b.aimYaw, desiredYaw)));
  b.aimPitch += Math.max(-turn, Math.min(turn, desiredPitch - b.aimPitch));

  return {
    seq: p.lastSeq + 1,
    moveX,
    moveZ,
    viewTick: tick & 0xffff, // bots see the live world
    yaw: b.aimYaw,
    pitch: b.aimPitch,
    jump,
    sprint,
    fire,
    reload,
    grenade,
    melee,
    build: false,
  };
}

function hasLineOfSight(from: Player, to: Player): boolean {
  readChar(to.body, to.state);
  const eye = eyePosition(from.state);
  const tx = to.state.x - eye[0];
  const ty = to.state.y + 1.0 - eye[1];
  const tz = to.state.z - eye[2];
  const dist = Math.hypot(tx, ty, tz);
  if (dist < 0.5) return true;
  const hit = castIgnoring(eye, [tx / dist, ty / dist, tz / dist], dist + 0.5, from.body);
  return hit !== null && hit.body === to.body;
}

function shortestArc(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function addPlayer(conn: Connection): void {
  for (const [connId, p] of players) {
    if (p.conn && p.userId === conn.userId) {
      p.conn.close("signed in from another connection");
      removePlayer(connId, p);
    }
  }
  if (players.size >= MAX_PLAYERS) {
    const bot = [...players.entries()].find(([, q]) => q.bot);
    if (bot) removeBot(bot[0]);
    else {
      conn.close("game is full");
      return;
    }
  }
  const usedIdx = new Set([...players.values()].map((p) => p.idx));
  let idx = 0;
  while (usedIdx.has(idx)) idx++;

  const park = parked.get(conn.userId);
  parked.delete(conn.userId);
  // Balance HUMANS across teams (bots backfill totals afterwards) — counting
  // bots here funnels every human onto one side, where half the battlefield
  // is friendlies their bullets ignore.
  let humansA = 0;
  let humansB = 0;
  for (const q of players.values()) {
    if (q.bot) continue;
    if (q.team === 0) humansA++;
    else humansB++;
  }
  const team = park?.team ?? (humansA <= humansB ? 0 : 1);

  const spawn = spawnPoint(team, idx);
  const p: Player = {
    conn,
    bot: null,
    idx,
    userId: conn.userId,
    name: conn.userName,
    team,
    body: createPlayerBody(gw, idx, spawn),
    state: makeChar(spawn),
    pending: new Map(),
    arrivalTicks: new Map(),
    lastCmd: { seq: 0, ...ZERO_INPUT },
    lastSeq: 0,
    lastSeqTick: tick,
    lastArrivalTick: tick,
    lastDepth: 0,
    hp: MAX_HP,
    dead: false,
    history: new PositionHistory(),
    respawnAtTick: 0,
    protectUntilTick: tick + PROTECT_TICKS,
    lastDamageTick: 0,
    kills: park?.kills ?? 0,
    deaths: park?.deaths ?? 0,
  };
  players.set(conn.id, p);

  const info: PlayerInfo = { idx: p.idx, name: p.name, team: p.team };
  sendTo(p, {
    type: "welcome",
    selfIdx: p.idx,
    players: [...players.values()].map((q) => ({ idx: q.idx, name: q.name, team: q.team })),
    serverTick: tick,
    phase,
    phaseEndTick,
    scores: [scores[0], scores[1]],
    mapEpoch,
    destroyed: [...destroyedPanels],
    built: [...builtPanels.values()],
    collapsed: [...collapsedBuildings],
    panelHp: [...panelHp.entries()],
    craters: [...craterList()],
  });
  broadcast({ type: "join", player: info }, p.conn?.id);
}

function removePlayer(connId: string, p: Player): void {
  players.delete(connId);
  removePlayerBody(gw, p.idx);
  parked.set(p.userId, {
    team: p.team,
    kills: p.kills,
    deaths: p.deaths,
    expiresAt: server.elapsedMs() + PARK_TTL_MS,
  });
  broadcast({ type: "leave", idx: p.idx });
}

// --- Inputs ---------------------------------------------------------------------

function drainInputs(): void {
  for (const event of server.datagrams.drain()) {
    const p = players.get(event.connection.id);
    if (!p) continue;
    const cmds = decodeInputs(event.bytes);
    if (!cmds) continue;
    for (const c of cmds) {
      if (c.seq <= p.lastSeq || p.pending.has(c.seq)) continue;
      if (p.pending.size >= MAX_BUFFERED_INPUTS) break;
      p.pending.set(c.seq, c);
      p.arrivalTicks.set(c.seq, tick);
    }
  }
}

function applyPlayerInput(p: Player): void {
  let cmd: InputCmd;
  if (p.bot) {
    cmd = botThink(p, p.bot);
    p.lastSeq++;
    p.lastSeqTick = tick;
    p.lastCmd = cmd;
    stepPlayerController(gw, p.body, p.state, cmd, {
      locked: p.dead || phase !== "playing",
      onFire: (eye, dir) => resolveShot(p, eye, dir),
      onMelee: (eye, dir) => resolveMelee(p, eye, dir),
      onGrenade: (origin, vel) => {
        const id = allocGrenadeId();
        grenades.push({
          id,
          ownerIdx: p.idx,
          fuseLeft: GRENADE_FUSE_TICKS,
          body: createGrenadeBody(gw, id, origin, vel),
        });
      },
    });
    return;
  }
  p.lastDepth = p.pending.size;
  if (p.pending.size > 0) {
    const seqs = [...p.pending.keys()].sort((a, b) => a - b);
    while (seqs.length > 8) p.pending.delete(seqs.shift()!);
    const seq = seqs[0];
    cmd = p.pending.get(seq)!;
    p.pending.delete(seq);
    p.lastArrivalTick = p.arrivalTicks.get(seq) ?? tick;
    for (const k of p.arrivalTicks.keys()) {
      if (k <= seq) p.arrivalTicks.delete(k);
    }
    p.lastSeq = seq;
    p.lastSeqTick = tick;
    p.lastCmd = cmd;
  } else {
    cmd = { ...p.lastCmd, seq: p.lastSeq };
  }

  const locked = p.dead || phase !== "playing" || cmd.seq === 0;
  stepPlayerController(gw, p.body, p.state, cmd, {
    locked,
    onFire: (eye, dir) => resolveShot(p, eye, dir),
    onMelee: (eye, dir) => resolveMelee(p, eye, dir),
    onGrenade: (origin, vel) => {
      const id = allocGrenadeId();
      grenades.push({
        id,
        ownerIdx: p.idx,
        fuseLeft: GRENADE_FUSE_TICKS,
        body: createGrenadeBody(gw, id, origin, vel),
      });
    },
    onBuild: (panel) => resolveBuild(p, panel),
  });
}

// --- Combat ----------------------------------------------------------------------

// Raycast that ignores the shooter's own capsule by skipping past it.
function castIgnoring(
  origin: readonly number[],
  dir: readonly number[],
  length: number,
  ignore: Body,
): { body: Body; point: [number, number, number] } | null {
  let ox = origin[0];
  let oy = origin[1];
  let oz = origin[2];
  let remaining = length;
  for (let hop = 0; hop < 3; hop++) {
    const hit = gw.world.castRay(
      [ox, oy, oz],
      [dir[0] * remaining, dir[1] * remaining, dir[2] * remaining],
    );
    if (!hit || !hit.body) return null;
    const px = ox + dir[0] * remaining * hit.fraction;
    const py = oy + dir[1] * remaining * hit.fraction;
    const pz = oz + dir[2] * remaining * hit.fraction;
    if (hit.body !== ignore) return { body: hit.body, point: [px, py, pz] };
    const step = remaining * hit.fraction + 0.45;
    ox += dir[0] * step;
    oy += dir[1] * step;
    oz += dir[2] * step;
    remaining -= step;
    if (remaining <= 0) return null;
  }
  return null;
}

// Where this player's capsule was `rewindTicks` ago (clamped to what we
// know) — the position the shooter actually saw on their screen.
// Per-player rewind history as a flat ring buffer: one reused Float64Array
// per player instead of 30 short-lived arrays a second, and one stable
// hidden class for V8. `rewound` returns a reused scratch — consume it
// before the next call.
const HISTORY_TICKS = 12;

class PositionHistory {
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

function rewoundFeet(q: Player, rewindTicks: number): readonly number[] | null {
  return q.history.rewound(rewindTicks);
}

interface AttackHit {
  victim: Player | null;
  panelBody: Body | null;
  point: [number, number, number];
}

// Shared lag-compensated hitscan: present-day walls occlude, but player
// capsules are tested where the shooter SAW them — their input carries the
// server tick of the world they were rendering (Source-style: rewind =
// client latency + client interpolation, measured exactly, not assumed).
function resolveAttack(
  p: Player,
  eye: [number, number, number],
  d: [number, number, number],
  range: number,
  rewindTicks: number,
): AttackHit {
  const wall = castWallDistance(gw, eye, d, range);
  let bestT = wall.dist;
  let victim: Player | null = null;
  for (const q of players.values()) {
    if (q === p || q.dead || q.team === p.team) continue;
    const feet = rewoundFeet(q, rewindTicks);
    if (!feet) continue;
    const t = rayVsCapsule(eye, d, bestT, feet);
    if (t !== null && t < bestT) {
      bestT = t;
      victim = q;
    }
  }
  if (victim) {
    return {
      victim,
      panelBody: null,
      point: [eye[0] + d[0] * bestT, eye[1] + d[1] * bestT, eye[2] + d[2] * bestT],
    };
  }
  return { victim: null, panelBody: wall.dist < range ? wall.body : null, point: wall.point };
}

function rewindFor(p: Player): number {
  // Bots aim at the live world; humans report what they were rendering.
  if (p.bot) return 1;
  const viewTick = unwrapViewTick(p.lastCmd.viewTick, tick);
  const bufferWait = Math.max(0, tick - p.lastArrivalTick);
  const clientView = Math.max(0, tick - bufferWait - viewTick);
  const rewind = Math.min(clientView, VIEW_REWIND_CAP_TICKS) + bufferWait;
  return Math.max(1, Math.min(HISTORY_TICKS, rewind));
}

function resolveShot(
  p: Player,
  eye: [number, number, number],
  dir: [number, number, number],
): void {
  // Spread is server-side randomness; the client predicts the muzzle effect
  // and ammo, never the trajectory.
  const spread = spreadFor(p.state);
  const d = perturb(dir, (rng() - 0.5) * 2 * spread, (rng() - 0.5) * 2 * spread);

  const hit = resolveAttack(p, eye, d, RIFLE_RANGE, rewindFor(p));
  pushEvent(EV_TRACER, p.idx, hit.point);
  if (hit.victim) {
    damagePlayer(hit.victim, RIFLE_DAMAGE, p, "rifle");
    // a packs victim (low nibble) and shooter (high nibble): idx < 16.
    pushEvent(EV_HIT_PLAYER, (hit.victim.idx & 0xf) | ((p.idx & 0xf) << 4), hit.point);
  } else if (hit.panelBody) {
    const pieceId = pieceIdFromHit(hit.panelBody, hit.point, pieceAlive);
    if (pieceId !== null) {
      damagePanel(pieceId, RIFLE_PANEL_DAMAGE);
      pushEvent(EV_PANEL_HIT, 0, hit.point);
    }
  }
}

function resolveMelee(
  p: Player,
  eye: [number, number, number],
  dir: [number, number, number],
): void {
  const hit = resolveAttack(p, eye, dir, MELEE_RANGE, rewindFor(p));
  pushEvent(EV_MELEE, p.idx, hit.point);
  if (hit.victim) {
    damagePlayer(hit.victim, MELEE_DAMAGE, p, "melee");
  } else if (hit.panelBody) {
    const pieceId = pieceIdFromHit(hit.panelBody, hit.point, pieceAlive);
    if (pieceId !== null) damagePanel(pieceId, MELEE_PANEL_DAMAGE);
  }
}

function resolveBuild(p: Player, panel: PanelDef): void {
  // Must sit inside the arena, on support, and away from players.
  const half = MAP.size / 2 - 1;
  const refund = () => {
    p.state.supply++;
  };
  if (Math.abs(panel.x) > half || Math.abs(panel.z) > half) return refund();
  const under = gw.world.castRay([panel.x, panel.y, panel.z], [0, -2.2, 0]);
  if (!under) return refund();
  for (const q of players.values()) {
    if (q.dead) continue;
    readChar(q.body, q.state);
    if (Math.hypot(q.state.x - panel.x, q.state.z - panel.z) < 1.0) return refund();
  }
  const placed: PanelDef = { ...panel, id: nextBuiltPanelId++ };
  addPanelBody(gw, placed);
  builtPanels.set(placed.id, placed);
  broadcast({ type: "build", panel: placed, byIdx: p.idx });
}

function damagePlayer(
  victim: Player,
  dmg: number,
  attacker: Player,
  weapon: "rifle" | "grenade" | "melee",
): void {
  if (SANDBOX) return;
  if (victim.dead || tick < victim.protectUntilTick || phase !== "playing") return;
  victim.hp -= dmg;
  victim.lastDamageTick = tick;
  if (victim.hp <= 0) {
    victim.hp = 0;
    victim.dead = true;
    victim.deaths++;
    victim.respawnAtTick = tick + RESPAWN_TICKS;
    if (attacker !== victim) {
      attacker.kills++;
      scores[attacker.team]++;
      broadcast({ type: "score", scores: [scores[0], scores[1]] });
    }
    broadcast({ type: "kill", killer: attacker.idx, victim: victim.idx, weapon });
    // Park the body at the spawn until respawn; clients hide it via RF_DEAD.
    const spawn = spawnPoint(victim.team, victim.idx);
    victim.state = makeChar(spawn);
    writeChar(victim.body, victim.state);
  }
}

const panelById = new Map(MAP.panels.map((p) => [p.id, p]));

// Static structural contact graph (who touches whom) — computed once; the
// map regenerates identically every round.
const CONTACTS = buildContactIndex();

// Masonry is bonded: a piece stands while its connected region (through
// touching alive pieces) still reaches the ground. When a piece dies, flood
// from each alive neighbor — regions that no longer reach ground are
// released whole, as one island, and fall as one rigid chunk. Breaking a
// window drops nothing; carving a seam drops the slab you cut loose.
const _floodSeen = new Set<number>();

function cascadeUnsupported(panelId: number): void {
  const neighbors = CONTACTS.adj.get(panelId);
  if (!neighbors) return;
  const safe = new Set<number>(); // verified ground-connected, this event
  for (const n of neighbors) {
    if (destroyedPanels.has(n) || safe.has(n)) continue;
    const island = floodToGround(n, safe);
    if (island) queueRelease(island);
  }
}

// BFS through alive contacts. Reaching a grounded (or known-safe) piece
// marks everything visited as safe and returns null; exhausting the region
// returns the disconnected island.
function floodToGround(start: number, safe: Set<number>): number[] | null {
  _floodSeen.clear();
  _floodSeen.add(start);
  const stack = [start];
  let i = 0;
  while (i < stack.length) {
    const id = stack[i++];
    if (CONTACTS.grounded.has(id) || safe.has(id)) {
      for (const v of _floodSeen) safe.add(v);
      return null;
    }
    for (const next of CONTACTS.adj.get(id) ?? []) {
      if (_floodSeen.has(next) || destroyedPanels.has(next)) continue;
      _floodSeen.add(next);
      stack.push(next);
    }
  }
  return stack;
}

// Releases are budgeted per tick, but an island is atomic — it falls as one
// chunk however big it is.
const releaseQueue: number[][] = [];
const RELEASE_PIECES_PER_TICK = 80;

function queueRelease(island: number[]): void {
  releaseQueue.push(island);
}

function drainReleases(): void {
  let n = 0;
  while (releaseQueue.length > 0 && n < RELEASE_PIECES_PER_TICK) {
    const island = releaseQueue.shift()!;
    for (const id of island) {
      if (destroyedPanels.has(id)) continue;
      releasePiece(id);
      n++;
    }
  }
}

// Settled pieces aren't in the static contact graph — when something is
// destroyed near them, probe whether their perch is gone and re-release the
// ones left hanging (each as its own one-piece island).
function recheckSettledNear(x: number, y: number, z: number): void {
  // Snapshot: releasing mutates builtPanels mid-iteration.
  const candidates = [...builtPanels];
  for (const [id, def] of candidates) {
    if (Math.abs(def.x - x) > 3 || Math.abs(def.z - z) > 3 || def.y < y - 0.3) continue;
    const halfH = (def.rot ? Math.max(def.ex, def.ey, def.ez) : def.ey) / 2;
    if (def.y - halfH < heightAt(def.x, def.z) + 0.2) continue; // on the ground
    const hit = gw.world.castRay([def.x, def.y - halfH - 0.03, def.z], [0, -0.35, 0]);
    if (!hit) queueRelease([id]);
  }
}

// Retire a still-alive static piece into this tick's release batch. The
// original id counts toward structure integrity (the wall really did lose
// it); the surviving piece tumbles inside a rigid chunk and re-enters play
// when the chunk settles. Glass shatters instead of tumbling.
function releasePiece(panelId: number): void {
  if (destroyedPanels.has(panelId)) return;
  const src = panelById.get(panelId) ?? builtPanels.get(panelId);
  if (!src) return;
  if (src.material === "glass" || falling.size >= FALLING_CAP) {
    destroyPanel(panelId, true);
    return;
  }
  destroyedPanels.add(panelId);
  panelHp.delete(panelId);
  builtPanels.delete(panelId);
  removePanelBody(gw, panelId);
  markPieceGone(panelId);
  pendingDestroys.push(panelId);
  releasedThisTick.push({
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
function launchReleasedChunks(): void {
  const batch = releasedThisTick.splice(0);
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
    const id = nextBuiltPanelId++;
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
    let vel: [number, number, number] = [(rng() - 0.5) * 0.4, 0, (rng() - 0.5) * 0.4];
    if (blastCtx && blastCtx.tick === tick) {
      const dx = origin[0] - blastCtx.x;
      const dy = origin[1] - blastCtx.y;
      const dz = origin[2] - blastCtx.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const kick = Math.min(7, 11 / (1 + d)) / Math.max(1, Math.sqrt(pieces.length / 4));
      vel = [(dx / d) * kick, Math.abs(dy / d) * kick * 0.5 + 1.5, (dz / d) * kick];
    }
    falling.set(id, {
      id,
      origin,
      pieces,
      body: createFallingChunkBody(gw, id, origin, pieces, vel),
      calmTicks: 0,
      bornTick: tick,
    });
    broadcast({ type: "fall", chunkId: id, origin, pieces });
  }
}

// Settle check: a chunk that has stopped moving (or timed out) splits back
// into individual static, destructible pieces at their final poses.
function stepFalling(): void {
  // Snapshot first: settling mutates the map mid-iteration.
  const active = [...falling.values()];
  for (const f of active) {
    const pos = f.body.translation();
    if (pos.y < -3) {
      falling.delete(f.id);
      gw.world.removeBody(f.body);
      continue;
    }
    const v = f.body.linearVelocity();
    const w = f.body.angularVelocity();
    const calm = Math.hypot(v.x, v.y, v.z) < 0.18 && Math.hypot(w.x, w.y, w.z) < 0.3;
    f.calmTicks = calm ? f.calmTicks + 1 : 0;
    if (f.calmTicks < 8 && tick - f.bornTick < FALL_TIMEOUT_TICKS) continue;

    const rot = f.body.rotation();
    falling.delete(f.id);
    gw.world.removeBody(f.body);
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
        id: nextBuiltPanelId++,
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
      addPanelBody(gw, def);
      builtPanels.set(def.id, def);
      settled.push(def);
    }
    broadcast({ type: "settle", chunkId: f.id, pieces: settled });
  }
}

function panelMaxHp(panelId: number): number {
  const def = panelById.get(panelId) ?? builtPanels.get(panelId);
  return def ? PANEL_HP[def.material] : PANEL_HP.metal;
}

function damagePanel(panelId: number, dmg: number): void {
  if (destroyedPanels.has(panelId)) return;
  const hp = (panelHp.get(panelId) ?? panelMaxHp(panelId)) - dmg;
  if (hp <= 0) destroyPanel(panelId);
  else {
    panelHp.set(panelId, hp);
    pendingHpUpdates.set(panelId, hp); // batched per tick for damage tinting
  }
}

function destroyPanel(panelId: number, leaveRubble = true): void {
  if (destroyedPanels.has(panelId)) return;
  const src = panelById.get(panelId) ?? builtPanels.get(panelId);
  destroyedPanels.add(panelId);
  panelHp.delete(panelId);
  builtPanels.delete(panelId);
  removePanelBody(gw, panelId);
  markPieceGone(panelId);
  pendingDestroys.push(panelId);
  if (leaveRubble && src) maybeLeaveRubble(src);
  if (leaveRubble && panelId < BUILT_PANEL_ID_BASE) cascadeUnsupported(panelId);
  if (leaveRubble && src) recheckSettledNear(src.x, src.y, src.z);
  // BattleBit-style critical health: enough wall damage fells the building.
  const buildingId = src?.buildingId;
  if (buildingId !== undefined && !collapsedBuildings.has(buildingId)) {
    const b = MAP.buildings[buildingId];
    const gone = b.wallPanelIds.filter((id) => destroyedPanels.has(id)).length;
    if (gone >= Math.ceil(b.wallPanelIds.length * b.collapseFraction)) {
      collapseBuilding(buildingId);
    }
  }
}

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

function maybeLeaveRubble(src: PanelDef): void {
  if (builtPanels.size >= RUBBLE_CAP) return;
  if (rng() >= (RUBBLE_CHANCE[src.material] ?? 0)) return;
  // The fragment IS a broken chunk of the destroyed piece: same material and
  // palette, a bite taken out of the original proportions, dropped at the
  // foot of where it died with a random resting yaw.
  const span = Math.max(src.ex, src.ez);
  const x = src.x + (rng() - 0.5) * Math.min(1.0, span);
  const z = src.z + (rng() - 0.5) * Math.min(1.0, span);
  const ey = src.ey * (0.8 + rng() * 0.2);
  const yaw = rng() * Math.PI;
  const def: PanelDef = {
    id: nextBuiltPanelId++,
    x,
    y: heightAt(x, z) + ey * 0.45,
    z,
    ex: src.ex * (0.4 + rng() * 0.3),
    ey,
    ez: src.ez * (0.75 + rng() * 0.25),
    material: src.material,
    rot: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    seed: src.seed ?? src.id,
    broken: true,
  };
  addPanelBody(gw, def);
  builtPanels.set(def.id, def);
  broadcast({ type: "build", panel: def, byIdx: -1 });
}

function collapseBuilding(buildingId: number): void {
  collapsedBuildings.add(buildingId); // before the cascade, so it can't recurse
  const b = MAP.buildings[buildingId];
  broadcast({ type: "collapse", buildingId });
  if (b.kind === "tree") {
    // The rest of the tree topples: every still-standing piece is released
    // intact and lands wherever physics takes it.
    for (const id of [...b.wallPanelIds, ...b.roofPanelIds]) releasePiece(id);
    return;
  }
  // Buildings implode: the dramatic full-structure drop with a rubble mound.
  for (const id of [...b.wallPanelIds, ...b.roofPanelIds]) destroyPanel(id, false);
  addRubbleBody(gw, b, RUBBLE_HEIGHT);
}

function flushDestroys(): void {
  if (pendingHpUpdates.size > 0) {
    broadcast({ type: "panelhp", updates: [...pendingHpUpdates.entries()] });
    pendingHpUpdates = new Map();
  }
  if (pendingDestroys.length === 0) return;
  broadcast({ type: "destroy", panelIds: pendingDestroys });
  pendingDestroys = [];
}

// --- Grenades ----------------------------------------------------------------------

function allocGrenadeId(): number {
  for (let i = 0; i < 256; i++) {
    const id = nextGrenadeId++ & 0xff;
    if (!grenades.some((g) => g.id === id)) return id;
  }
  return nextGrenadeId & 0xff;
}

function stepGrenades(): void {
  for (const g of grenades.slice()) {
    g.fuseLeft--;
    if (g.fuseLeft > 0) continue;
    const pos = g.body.translation();
    removeGrenadeBody(gw, g.id);
    grenades = grenades.filter((x) => x !== g);
    explode([pos.x, pos.y, pos.z], g.ownerIdx);
  }
}

function explode(at: [number, number, number], ownerIdx: number): void {
  pushEvent(EV_EXPLOSION, 0, at);
  blastCtx = { x: at[0], y: at[1], z: at[2], tick };
  const owner = playerByIdx(ownerIdx);

  // Players: radial damage (friendly fire off, self damage on) + impulse.
  for (const p of players.values()) {
    if (p.dead) continue;
    readChar(p.body, p.state);
    const dx = p.state.x - at[0];
    const dy = p.state.y + PLAYER_HALF_HEIGHT - at[1];
    const dz = p.state.z - at[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > EXPLOSION_RADIUS) continue;
    const falloff = 1 - dist / EXPLOSION_RADIUS;
    const friendly = owner !== undefined && p.team === owner.team && p.idx !== ownerIdx;
    if (!friendly && owner) {
      const dmg = EXPLOSION_MIN_DAMAGE + (EXPLOSION_MAX_DAMAGE - EXPLOSION_MIN_DAMAGE) * falloff;
      damagePlayer(p, Math.round(dmg), owner, "grenade");
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
    applyCraterBodies(gw, crater);
    broadcast({ type: "crater", crater });
  }

  // Panels: deleted outright up close, chipped in an outer falloff ring.
  const blastPanel = (id: number, px: number, py: number, pz: number) => {
    const dist = Math.hypot(px - at[0], py - at[1], pz - at[2]);
    if (dist <= EXPLOSION_PANEL_RADIUS) destroyPanel(id);
    else if (dist <= EXPLOSION_PANEL_OUTER_RADIUS) damagePanel(id, EXPLOSION_PANEL_OUTER_DAMAGE);
  };
  for (const p of MAP.panels) {
    if (!destroyedPanels.has(p.id)) blastPanel(p.id, p.x, p.y, p.z);
  }
  // Snapshot first: blast-destroyed pieces shed rubble INTO builtPanels
  // mid-loop, and freshly shed chunks shouldn't be vaporized by the same
  // blast that created them.
  const preBlast = [...builtPanels];
  for (const [id, p] of preBlast) blastPanel(id, p.x, p.y, p.z);

  // Other grenades get knocked around.
  for (const g of grenades) {
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

// --- Lifecycle ------------------------------------------------------------------------

// Cap on the CLIENT-attributable rewind (interp delay + transit): 120ms.
// The server's own input-buffer wait is added on top uncapped — that delay
// is ours, not the shooter's ping, and exists even on LAN.
const VIEW_REWIND_CAP_TICKS = Math.round(120 / TICK_MS);

function stepLifecycles(): void {
  for (const p of players.values()) {
    readChar(p.body, p.state);
    p.history.push(p.state.x, p.state.y, p.state.z);
    if (p.dead) p.history.clear(); // don't rewind into a corpse

    if (p.dead && tick >= p.respawnAtTick && phase === "playing") {
      const spawn = spawnPoint(p.team, p.idx);
      p.state = makeChar(spawn);
      writeChar(p.body, p.state);
      p.hp = MAX_HP;
      p.dead = false;
      p.protectUntilTick = tick + PROTECT_TICKS;
    }
    if (!p.dead && p.hp < MAX_HP && tick - p.lastDamageTick > REGEN_DELAY_TICKS) {
      p.hp = Math.min(MAX_HP, p.hp + REGEN_PER_TICK);
    }
  }
}

async function stepPhase(): Promise<void> {
  if (SANDBOX) {
    // Endless round: the test environment never resets the world.
    phaseEndTick = tick + ROUND_TICKS;
    return;
  }
  if (phase === "playing") {
    if (
      players.size > 0 &&
      (tick >= phaseEndTick || scores[0] >= SCORE_LIMIT || scores[1] >= SCORE_LIMIT)
    ) {
      phase = "results";
      phaseEndTick = tick + RESULTS_TICKS;
      broadcast({ type: "phase", phase, phaseEndTick, scores: [scores[0], scores[1]], mapEpoch });
    } else if (players.size === 0 && tick >= phaseEndTick) {
      phaseEndTick = tick + ROUND_TICKS; // idle server: keep pushing the clock
    }
  } else if (tick >= phaseEndTick) {
    await resetRound();
  }
}

async function resetRound(): Promise<void> {
  destroyGameWorld(gw);
  falling.clear();
  releasedThisTick.length = 0;
  releaseQueue.length = 0;
  dirtySlabs.clear();
  resetCraters();
  gw = await createGameWorld();
  panelHp.clear();
  destroyedPanels.clear();
  builtPanels.clear();
  collapsedBuildings.clear();
  pendingHpUpdates = new Map();
  pendingDestroys = [];
  grenades = [];
  scores[0] = 0;
  scores[1] = 0;
  mapEpoch++;
  rng = mulberry32((tick * 2654435761) >>> 0 || 1);
  for (const p of players.values()) {
    const spawn = spawnPoint(p.team, p.idx);
    p.body = createPlayerBody(gw, p.idx, spawn);
    p.state = makeChar(spawn);
    p.pending.clear();
    p.lastCmd = { seq: 0, ...ZERO_INPUT };
    p.hp = MAX_HP;
    p.dead = false;
    p.kills = 0;
    p.deaths = 0;
    p.protectUntilTick = tick + PROTECT_TICKS;
  }
  phase = "playing";
  phaseEndTick = tick + ROUND_TICKS;
  broadcast({ type: "phase", phase, phaseEndTick, scores: [scores[0], scores[1]], mapEpoch });
}

// --- Outbound ---------------------------------------------------------------------------

function playerByIdx(idx: number): Player | undefined {
  for (const p of players.values()) {
    if (p.idx === idx) return p;
  }
  return undefined;
}

function pushEvent(kind: number, a: number, point: readonly number[]): void {
  events.push({ seq: nextEventSeq++ & 0xffff, kind, a, x: point[0], y: point[1], z: point[2] });
  if (events.length > EVENT_RING) events.shift();
}

function broadcast(msg: ServerMsg, exceptConnId?: string): void {
  server.streams.broadcast(
    JSON.stringify(msg),
    exceptConnId ? { except: [exceptConnId] } : undefined,
  );
}

function sendTo(p: Player, msg: ServerMsg): void {
  if (!p.conn) return;
  server.streams.send(p.conn.id, JSON.stringify(msg));
}

function broadcastSnapshots(): void {
  if (players.size === 0) return;
  const all = [...players.values()];
  for (const p of all) readChar(p.body, p.state);

  const chunkSnaps: ChunkSnap[] = [];
  for (const f of falling.values()) {
    if (chunkSnaps.length >= 32) break;
    const pos = f.body.translation();
    const rot = f.body.rotation();
    chunkSnaps.push({
      id: f.id & 0xffff,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      qx: rot.x,
      qy: rot.y,
      qz: rot.z,
      qw: rot.w,
    });
  }

  const entities: EntitySnap[] = grenades.map((g) => {
    const pos = g.body.translation();
    const vel = g.body.linearVelocity();
    return {
      id: g.id,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      vx: vel.x,
      vy: vel.y,
      vz: vel.z,
      fuseTicks: Math.max(0, g.fuseLeft),
    };
  });

  for (const p of all) {
    if (!p.conn) continue; // bots don't receive snapshots
    const remotes: RemoteSnap[] = [];
    for (const q of all) {
      if (q === p) continue;
      let flags = 0;
      if (q.team === 1) flags |= RF_TEAM;
      if (q.state.onGround) flags |= RF_GROUND;
      if (q.dead) flags |= RF_DEAD;
      if (q.lastCmd.sprint) flags |= RF_SPRINT;
      if (q.state.reloadTicks > 0) flags |= RF_RELOADING;
      if (tick < q.protectUntilTick) flags |= RF_PROTECTED;
      remotes.push({
        idx: q.idx,
        flags,
        x: q.state.x,
        y: q.state.y,
        z: q.state.z,
        yaw: q.lastCmd.yaw,
        pitch: q.lastCmd.pitch,
      });
    }
    let status = 0;
    if (p.dead) status |= SS_DEAD;
    if (tick < p.protectUntilTick) status |= SS_PROTECTED;
    const packet = encodeSnapshot({
      serverTick: tick,
      phase: phase === "playing" ? 0 : 1,
      phaseEndTick,
      chunks: chunkSnaps,
      self: {
        ackSeq: p.lastSeq,
        ackTick: p.lastSeqTick,
        status,
        bufferDepth: p.lastDepth,
        hp: p.hp,
        respawnTicks: p.dead ? Math.max(0, p.respawnAtTick - tick) : 0,
        state: p.state,
      },
      remotes,
      entities,
      events: [...events],
    });
    server.datagrams.send(p.conn.id, packet);
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

function perturb(dir: [number, number, number], dx: number, dy: number): [number, number, number] {
  // Small-angle perturbation in the plane perpendicular to dir.
  let rx = dir[2];
  let ry = 0;
  let rz = -dir[0];
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = ry * dir[2] - rz * dir[1];
  const uy = rz * dir[0] - rx * dir[2];
  const uz = rx * dir[1] - ry * dir[0];
  const ox = dir[0] + rx * dx + ux * dy;
  const oy = dir[1] + ry * dx + uy * dy;
  const oz = dir[2] + rz * dx + uz * dy;
  const l = Math.hypot(ox, oy, oz) || 1;
  return [ox / l, oy / l, oz / l];
}
