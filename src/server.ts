// Authoritative FPS server: the deterministic simulation itself lives in
// shared/sim.ts (one Jolt world stepped at the tick rate, players as dynamic
// capsules, server-authoritative destruction); this module owns everything
// around it — connections, per-player input buffering, bot brains, and
// outbound traffic. Reliable messages (destruction, kills, round flow) drain
// from the sim's outbox over QUIC streams, while transient effects (tracers,
// impacts, explosions) ride a ring of recent events inside the idempotent
// snapshots.

import { type Connection, type StreamEvent, server } from "snack:server";
import {
  BOT_FILL,
  SANDBOX,
  MAX_PLAYERS,
  RESULTS_TICKS,
  ROUND_TICKS,
  TICK_MS,
} from "./shared/constants.js";
import {
  craterList,
  DEFAULT_MAP_SEED,
  ENEMY_BASE_RADIUS,
  heightAt,
  initMap,
  PLAY_HALF,
  ZONES,
} from "./shared/map.js";
import { parseClientMsg, type PlayerInfo, type ServerMsg } from "./shared/messages.js";
import {
  decodeInputs,
  encodeSnapshot,
  packWeaponByte,
  type ChunkSnap,
  type EntitySnap,
  type RemoteSnap,
  type ZoneSnap,
  RF_CROUCH,
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
  aimDirection,
  eyePosition,
  type InputCmd,
  joltFreeMemory,
  joltModule,
  readChar,
} from "./shared/physics.js";
import { BotNav, initBotNav, type BotNavPoint } from "./server/botNav.js";
import { CLASSES, secondaryIdxFor } from "./shared/weapons.js";
import { GameSim, type SimPlayer } from "./shared/sim.js";

// The Snack runtime provides console/performance; the DOM-less lib doesn't type them.
declare const console: { log(...args: unknown[]): void };

const MAX_BUFFERED_INPUTS = 90;
const PARK_TTL_MS = 5 * 60 * 1000;
const BOT_DECISION_INTERVAL = 6;
const BOT_TARGET_VISIBILITY_TICKS = BOT_DECISION_INTERVAL + 2;
const BOT_STUCK_CHECK_INTERVAL = 45;

// A bot's standing decisions; null for humans.
interface BotBrain {
  wanderX: number;
  wanderY: number;
  wanderZ: number;
  repathAtTick: number;
  targetIdx: number; // -1 when no enemy in sight
  targetVisibleUntilTick: number;
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
  path: BotNavPoint[];
  pathIdx: number;
  pathTargetX: number;
  pathTargetY: number;
  pathTargetZ: number;
  pathRefreshAtTick: number;
  pathVersion: number;
  desiredYaw: number;
  desiredPitch: number;
  moveX: number;
  moveZ: number;
  fireIntent: boolean;
  meleeIntent: boolean;
  jumpIntent: boolean;
  grenadeIntent: boolean;
  reloadIntent: boolean;
  sprintIntent: boolean;
}

// Connection-side wrapper around a sim slot: identity and input buffering
// live here; everything gameplay (body, hp, team, ...) is the SimPlayer.
interface Player {
  conn: Connection | null; // null = bot
  bot: BotBrain | null;
  slot: number; // index into sim players
  userId: string;
  name: string;
  pending: Map<number, InputCmd>;
  arrivalTicks: Map<number, number>; // seq -> tick the input arrived
  lastSeq: number;
  lastSeqTick: number;
  lastArrivalTick: number; // when the applied input ARRIVED (buffer wait = apply - arrival)
  lastDepth: number;
}

interface Parked {
  team: number;
  kills: number;
  deaths: number;
  classId: number;
  expiresAt: number;
}

// --- Global state ------------------------------------------------------------

let sim: GameSim;
let mapEpoch = 1;
let mapSeed = DEFAULT_MAP_SEED;
let configuredBotFill = BOT_FILL;
let botNav: BotNav | null = null;

// Every game is a new level: a fresh seed at boot and per round restart,
// announced in welcome/phase messages so every client rebuilds the same
// world. SANDBOX keeps the fixture seed for reproducible iteration.
function pickMapSeed(): number {
  if (SANDBOX) return DEFAULT_MAP_SEED;
  return ((Math.random() * 0x100000000) ^ (server.elapsedMs() * 2654435761)) >>> 0;
}

const players = new Map<string, Player>(); // by connection id, or "bot:<n>"
const parked = new Map<string, Parked>();
let nextBotSerial = 0;
const BOT_NAMES = ["Ash", "Brick", "Castle", "Dune", "Echo", "Flint", "Gravel", "Hatch"];

function simOf(p: Player): SimPlayer {
  return sim.player(p.slot)!;
}

function readBotFillConfig(): number {
  const raw = server.config.botFill;
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : raw === false
          ? 0
          : BOT_FILL;
  if (!Number.isFinite(value)) return BOT_FILL;
  return Math.max(0, Math.min(MAX_PLAYERS, Math.round(value)));
}

export async function main() {
  await joltModule();
  mapSeed = pickMapSeed();
  initMap(mapSeed); // before sim.init(): the physics world builds from MAP
  sim = new GameSim(0xbeac4);
  await sim.init();
  sim.phaseEndTick = ROUND_TICKS;
  configuredBotFill = readBotFillConfig();
  if (!SANDBOX && configuredBotFill > 0) {
    await initBotNav();
    botNav = new BotNav();
    botNav.warm(sim);
  }

  // Client stream messages carry explicit requests (currently the spawn
  // choice). The recv REJECTING is the shutdown signal — it only rejects
  // when the runtime stops this module.
  let stopped = false;
  const stopSignal = (async () => {
    try {
      while (true) {
        handleClientMsg(await server.streams.recv());
      }
    } catch {
      stopped = true; // the runtime is stopping this module
    }
  })();

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
  sim.tick++;
  syncConnections();
  drainInputs();

  for (const p of players.values()) applyPlayerInput(p);
  const t1 = server.elapsedMs();

  sim.stepWorld();
  const t2 = server.elapsedMs();

  for (const msg of sim.outbox) broadcast(msg);
  sim.outbox.length = 0;
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
    // Stay silent while healthy; speak up when the tick budget is threatened
    // or the fixed Jolt heap is running down (OOM aborts the runtime).
    const avg = perfTotalMs / perfTicks;
    const freeMb = joltFreeMemory() / 1048576;
    if (avg > 5 || perfWorstMs > 25 || (freeMb >= 0 && freeMb < 40)) {
      console.log(
        `[perf] tick avg=${(perfTotalMs / perfTicks).toFixed(2)}ms worst=${perfWorstMs.toFixed(1)}ms ` +
          `(input+bots=${(perfInputMs / perfTicks).toFixed(2)} physics=${(perfStepMs / perfTicks).toFixed(2)} ` +
          `out=${(perfSnapMs / perfTicks).toFixed(2)}) players=${players.size} joltFree=${freeMb.toFixed(1)}MB`,
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
    if (simOf(p).team === 0) a++;
    else b++;
  }
  return [a, b];
}

// --- Bots: fill the lobby, leave one-for-one as humans join. -------------------

function syncBots(): void {
  if (SANDBOX || configuredBotFill <= 0) return;
  let humans = 0;
  let bots = 0;
  for (const p of players.values()) {
    if (p.bot) bots++;
    else humans++;
  }
  const desired = Math.max(0, Math.min(configuredBotFill - humans, MAX_PLAYERS - humans));
  while (bots < desired) {
    addBot();
    bots++;
  }
  while (bots > desired) {
    // Trim from the larger team to keep the match balanced.
    const [a, b] = teamCounts();
    const fromTeam = a >= b ? 0 : 1;
    const entry =
      [...players.entries()].find(([, q]) => q.bot && simOf(q).team === fromTeam) ??
      [...players.entries()].find(([, q]) => q.bot);
    if (!entry) break;
    removeBot(entry[0]);
    bots--;
  }
}

function addBot(): void {
  const usedIdx = new Set([...players.values()].map((p) => p.slot));
  let slot = 0;
  while (usedIdx.has(slot)) slot++;
  const [a, b] = teamCounts();
  const team = a <= b ? 0 : 1;
  const serial = nextBotSerial++;
  const name = `BOT ${BOT_NAMES[serial % BOT_NAMES.length]}`;
  // Bots spread across the classes so every weapon shows up on the field.
  const sp = sim.addPlayer(slot, team, serial % CLASSES.length);
  const p: Player = {
    conn: null,
    bot: {
      wanderX: 0,
      wanderY: sp.state.y,
      wanderZ: 0,
      repathAtTick: 0,
      targetIdx: -1,
      targetVisibleUntilTick: 0,
      burstUntil: 0,
      pauseUntil: 0,
      aimYaw: 0,
      aimPitch: 0,
      strafeSign: 1,
      strafeFlipAt: 0,
      stuckX: sp.state.x,
      stuckZ: sp.state.z,
      stuckCheckAt: initialBotStuckCheckTick(slot),
      grenadeReadyAt: sim.tick + 300,
      path: [],
      pathIdx: 0,
      pathTargetX: Number.NaN,
      pathTargetY: Number.NaN,
      pathTargetZ: Number.NaN,
      pathRefreshAtTick: 0,
      pathVersion: 0,
      desiredYaw: 0,
      desiredPitch: 0,
      moveX: 0,
      moveZ: 0,
      fireIntent: false,
      meleeIntent: false,
      jumpIntent: false,
      grenadeIntent: false,
      reloadIntent: false,
      sprintIntent: false,
    },
    slot,
    userId: `bot:${serial}`,
    name,
    pending: new Map(),
    arrivalTicks: new Map(),
    lastSeq: 0,
    lastSeqTick: sim.tick,
    lastArrivalTick: sim.tick,
    lastDepth: 0,
  };
  players.set(`bot:${serial}`, p);
  broadcast({ type: "join", player: { idx: slot, name, team } });
}

function removeBot(key: string): void {
  const p = players.get(key);
  if (!p) return;
  players.delete(key);
  sim.removePlayer(p.slot);
  broadcast({ type: "leave", idx: p.slot });
}

// Bots still emit one input per server tick, but expensive decisions are
// sharded across slots. With 30 bots, this runs about five full brain updates
// per tick and lets the rest reuse cached intent.
function botThink(p: SimPlayer, b: BotBrain, lastSeq: number): InputCmd {
  if (shouldUpdateBotDecision(p.idx)) updateBotDecision(p, b);
  return makeBotInput(p, b, lastSeq);
}

function shouldUpdateBotDecision(slot: number): boolean {
  return sim.tick % BOT_DECISION_INTERVAL === slot % BOT_DECISION_INTERVAL;
}

function updateBotDecision(p: SimPlayer, b: BotBrain): void {
  const tick = sim.tick;
  const rng = sim.rng;
  readChar(p.body, p.state);
  const s = p.state;
  const eye = eyePosition(s);

  // --- Acquire / validate a target (LoS checked with a real raycast). ---
  const current = b.targetIdx >= 0 ? sim.player(b.targetIdx) : null;
  if (current && !current.dead && hasLineOfSight(p, current)) {
    b.targetVisibleUntilTick = tick + BOT_TARGET_VISIBILITY_TICKS;
  } else {
    b.targetIdx = -1;
    b.targetVisibleUntilTick = 0;
    let bestDist = 42;
    for (const q of sim.players) {
      if (!q || q.team === p.team || q.dead) continue;
      readChar(q.body, q.state);
      const d = Math.hypot(q.state.x - s.x, q.state.z - s.z);
      if (d < bestDist && hasLineOfSight(p, q)) {
        bestDist = d;
        b.targetIdx = q.idx;
        b.targetVisibleUntilTick = tick + BOT_TARGET_VISIBILITY_TICKS;
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

  const target =
    b.targetIdx >= 0 && tick <= b.targetVisibleUntilTick ? sim.player(b.targetIdx) : null;
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
    fire = tick < b.burstUntil;
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
      // Play the objective: usually head for a flag we don't hold.
      const targets = ZONES.filter((_, i) => sim.zones[i].owner !== p.team);
      if (targets.length > 0 && rng() < 0.7) {
        const t = targets[Math.floor(rng() * targets.length)];
        setBotDestination(
          b,
          t.x + (rng() * 2 - 1) * 7,
          heightAt(t.x, t.z) + 0.15,
          t.z + (rng() * 2 - 1) * 7,
        );
      } else {
        const bound = PLAY_HALF - 5; // keep bots inside the play area (no OOB suicides)
        // The enemy home bowl runs the return-or-die countdown — never send a
        // bot to wander (and die) in there.
        const enemySpawnZ = p.team === 0 ? 100 : -100;
        const outsideEnemyBase = (x: number, z: number): number => {
          if (Math.hypot(x, z - enemySpawnZ) >= ENEMY_BASE_RADIUS + 6) return z;
          return enemySpawnZ - Math.sign(enemySpawnZ) * (ENEMY_BASE_RADIUS + 8 + rng() * 12);
        };
        const randomPoint = navForBots()?.randomPoint(sim, rng);
        if (randomPoint && rng() < 0.65) {
          const rx = Math.max(-bound, Math.min(bound, randomPoint[0]));
          const rz = outsideEnemyBase(rx, Math.max(-bound, Math.min(bound, randomPoint[2])));
          setBotDestination(b, rx, heightAt(rx, rz) + 0.15, rz);
        } else {
          const half = bound;
          const x = (rng() * 2 - 1) * half;
          const z = outsideEnemyBase(x, (rng() * 2 - 1) * half);
          setBotDestination(b, x, heightAt(x, z) + 0.15, z);
        }
      }
      b.repathAtTick = tick + 240 + Math.floor(rng() * 240);
    }
    const steer = botSteerDestination(s.x, s.y, s.z, b, rng);
    const len = Math.hypot(steer.x, steer.z) || 1;
    moveX = steer.x / len;
    moveZ = steer.z / len;
    desiredYaw = Math.atan2(moveX, moveZ);
    if (steer.y > s.y + 0.45 && len < 1.5) jump = true;
    sprint = true;
    if (s.ammo < 12) reload = true;
  }

  // --- Stuck? Sledge through whatever wall is in the way, BattleBit style. ---
  if (tick >= b.stuckCheckAt) {
    const moved = Math.hypot(s.x - b.stuckX, s.z - b.stuckZ);
    if (moved < 0.5 && !p.dead && (moveX !== 0 || moveZ !== 0)) {
      const dir = aimDirection(b.aimYaw, 0);
      const ahead = sim.gw.world.castRay(
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
    b.stuckCheckAt = tick + BOT_STUCK_CHECK_INTERVAL;
  }

  b.desiredYaw = desiredYaw;
  b.desiredPitch = desiredPitch;
  b.moveX = moveX;
  b.moveZ = moveZ;
  b.fireIntent = fire;
  b.meleeIntent = melee;
  b.jumpIntent = jump;
  b.grenadeIntent = grenade;
  b.reloadIntent = reload;
  b.sprintIntent = sprint;
}

function makeBotInput(p: SimPlayer, b: BotBrain, lastSeq: number): InputCmd {
  const tick = sim.tick;
  refreshCombatIntent(p, b);
  // Turn toward the desired view at a finite speed so bots feel human-ish.
  const turn = 0.22; // rad/tick (~6.6 rad/s)
  b.aimYaw += Math.max(-turn, Math.min(turn, shortestArc(b.aimYaw, b.desiredYaw)));
  b.aimPitch += Math.max(-turn, Math.min(turn, b.desiredPitch - b.aimPitch));
  const aligned = Math.abs(shortestArc(b.aimYaw, b.desiredYaw)) < 0.07;

  const cmd = {
    seq: lastSeq + 1,
    moveX: b.moveX,
    moveZ: b.moveZ,
    viewTick: tick & 0xffff, // bots see the live world
    yaw: b.aimYaw,
    pitch: b.aimPitch,
    jump: b.jumpIntent,
    sprint: b.sprintIntent,
    crouch: false, // bots don't crouch (yet)
    fire: b.fireIntent && aligned && tick < b.burstUntil && tick <= b.targetVisibleUntilTick,
    reload: b.reloadIntent,
    grenade: b.grenadeIntent,
    melee: b.meleeIntent,
    build: false,
    slot2: false, // bots stick to their class primary
  };
  b.jumpIntent = false;
  b.grenadeIntent = false;
  b.meleeIntent = false;
  return cmd;
}

function refreshCombatIntent(p: SimPlayer, b: BotBrain): void {
  const target =
    b.targetIdx >= 0 && sim.tick <= b.targetVisibleUntilTick ? sim.player(b.targetIdx) : null;
  if (!target || target.dead) return;
  readChar(p.body, p.state);
  readChar(target.body, target.state);
  const eye = eyePosition(p.state);
  const dx = target.state.x - p.state.x;
  const dz = target.state.z - p.state.z;
  const dist = Math.hypot(dx, dz);
  const wobble = 0.012 + dist * 0.0011;
  const phase = sim.tick * 0.37 + p.idx * 1.9;
  b.desiredYaw = Math.atan2(dx, dz) + Math.sin(phase) * wobble;
  b.desiredPitch =
    Math.atan2(target.state.y + 1.0 - eye[1], dist) + Math.cos(phase * 0.7) * wobble * 0.5;
  const nx = dx / (dist || 1);
  const nz = dz / (dist || 1);
  b.moveX = -nz * b.strafeSign;
  b.moveZ = nx * b.strafeSign;
  if (dist > 22) {
    b.moveX += nx * 0.8;
    b.moveZ += nz * 0.8;
  } else if (dist < 7) {
    b.moveX -= nx * 0.8;
    b.moveZ -= nz * 0.8;
  }
}

function initialBotStuckCheckTick(slot: number): number {
  return sim.tick + 6 + ((slot * 17) % BOT_STUCK_CHECK_INTERVAL);
}

function setBotDestination(b: BotBrain, x: number, y: number, z: number): void {
  b.wanderX = x;
  b.wanderY = y;
  b.wanderZ = z;
  b.path = [];
  b.pathIdx = 0;
  b.pathTargetX = Number.NaN;
  b.pathTargetY = Number.NaN;
  b.pathTargetZ = Number.NaN;
  b.pathRefreshAtTick = 0;
}

function botSteerDestination(
  x: number,
  y: number,
  z: number,
  b: BotBrain,
  rng: () => number,
): { x: number; y: number; z: number } {
  const nav = navForBots();
  if (nav) {
    const targetShift = Math.hypot(b.pathTargetX - b.wanderX, b.pathTargetZ - b.wanderZ);
    const shouldRetryMissingPath = b.path.length === 0 && sim.tick >= b.pathRefreshAtTick;
    if (shouldRetryMissingPath || b.pathVersion !== nav.version || targetShift > 1.2) {
      const route = nav.findRoute(sim, [x, y, z], [b.wanderX, b.wanderY, b.wanderZ]);
      b.path = route ?? [];
      b.pathIdx = b.path.length > 1 ? 1 : 0;
      b.pathTargetX = b.wanderX;
      b.pathTargetY = b.wanderY;
      b.pathTargetZ = b.wanderZ;
      b.pathRefreshAtTick =
        b.path.length > 0 ? Number.MAX_SAFE_INTEGER : sim.tick + 90 + Math.floor(rng() * 90);
      b.pathVersion = nav.version;
    }
    while (b.pathIdx < b.path.length - 1) {
      const point = b.path[b.pathIdx];
      if (Math.hypot(point[0] - x, point[2] - z) >= 1.05) break;
      b.pathIdx++;
    }
    const point = b.path[b.pathIdx];
    if (point) {
      return { x: point[0] - x, y: point[1], z: point[2] - z };
    }
  }
  return { x: b.wanderX - x, y: b.wanderY, z: b.wanderZ - z };
}

function navForBots(): BotNav | null {
  if (SANDBOX || configuredBotFill <= 0) return null;
  botNav ??= new BotNav();
  return botNav;
}

function hasLineOfSight(from: SimPlayer, to: SimPlayer): boolean {
  readChar(to.body, to.state);
  const eye = eyePosition(from.state);
  const tx = to.state.x - eye[0];
  const ty = to.state.y + 1.0 - eye[1];
  const tz = to.state.z - eye[2];
  const dist = Math.hypot(tx, ty, tz);
  if (dist < 0.5) return true;
  const hit = sim.gw.world.castRay(
    eye,
    [(tx / dist) * (dist + 0.5), (ty / dist) * (dist + 0.5), (tz / dist) * (dist + 0.5)],
    { excludeBody: from.body },
  );
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
  const usedIdx = new Set([...players.values()].map((p) => p.slot));
  let slot = 0;
  while (usedIdx.has(slot)) slot++;

  const park = parked.get(conn.userId);
  parked.delete(conn.userId);
  // Balance HUMANS across teams (bots backfill totals afterwards) — counting
  // bots here funnels every human onto one side, where half the battlefield
  // is friendlies their bullets ignore.
  let humansA = 0;
  let humansB = 0;
  for (const q of players.values()) {
    if (q.bot) continue;
    if (simOf(q).team === 0) humansA++;
    else humansB++;
  }
  const team = park?.team ?? (humansA <= humansB ? 0 : 1);

  const sp = sim.addPlayer(slot, team, park?.classId ?? 0);
  sp.autoRespawn = false; // humans deploy from the respawn screen
  sp.kills = park?.kills ?? 0;
  sp.deaths = park?.deaths ?? 0;
  const p: Player = {
    conn,
    bot: null,
    slot,
    userId: conn.userId,
    name: conn.userName,
    pending: new Map(),
    arrivalTicks: new Map(),
    lastSeq: 0,
    lastSeqTick: sim.tick,
    lastArrivalTick: sim.tick,
    lastDepth: 0,
  };
  players.set(conn.id, p);

  const info: PlayerInfo = { idx: slot, name: p.name, team };
  sendTo(p, {
    type: "welcome",
    selfIdx: slot,
    players: [...players.values()].map((q) => ({ idx: q.slot, name: q.name, team: simOf(q).team })),
    serverTick: sim.tick,
    phase: sim.phase,
    phaseEndTick: sim.phaseEndTick,
    scores: [sim.scores[0], sim.scores[1]],
    mapEpoch,
    mapSeed,
    destroyed: [...sim.destroyedPanels],
    built: [...sim.builtPanels.values()],
    collapsed: [...sim.collapsedBuildings],
    panelHp: [...sim.panelHp.entries()],
    craters: [...craterList()],
  });
  broadcast({ type: "join", player: info }, p.conn?.id);
}

function removePlayer(connId: string, p: Player): void {
  const sp = simOf(p);
  players.delete(connId);
  sim.removePlayer(p.slot);
  parked.set(p.userId, {
    team: sp.team,
    kills: sp.kills,
    deaths: sp.deaths,
    classId: sp.classId,
    expiresAt: server.elapsedMs() + PARK_TTL_MS,
  });
  broadcast({ type: "leave", idx: p.slot });
}

// --- Inputs ---------------------------------------------------------------------

// Reliable client requests. Validate hard: anything malformed or from an
// unknown connection is dropped silently.
function handleClientMsg(event: StreamEvent): void {
  let msg = null;
  try {
    msg = parseClientMsg(event.json());
  } catch {
    return;
  }
  if (!msg) return;
  const p = players.get(event.connection.id);
  if (!p || p.bot) return;
  if (msg.type === "spawnat") sim.setSpawnZone(p.slot, msg.zone);
  else if (msg.type === "deploy") sim.requestDeploy(p.slot);
  else if (msg.type === "class") sim.setClass(p.slot, msg.cls);
}

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
      p.arrivalTicks.set(c.seq, sim.tick);
    }
  }
}

function applyPlayerInput(p: Player): void {
  const sp = simOf(p);
  let cmd: InputCmd;
  if (p.bot) {
    cmd = botThink(sp, p.bot, p.lastSeq);
    p.lastSeq++;
    p.lastSeqTick = sim.tick;
    sim.applyInput(p.slot, cmd, { locked: sp.dead || sim.phase !== "playing", isBot: true });
    return;
  }
  p.lastDepth = p.pending.size;
  if (p.pending.size > 0) {
    const seqs = [...p.pending.keys()].sort((a, b) => a - b);
    while (seqs.length > 8) p.pending.delete(seqs.shift()!);
    const seq = seqs[0];
    cmd = p.pending.get(seq)!;
    p.pending.delete(seq);
    p.lastArrivalTick = p.arrivalTicks.get(seq) ?? sim.tick;
    for (const k of p.arrivalTicks.keys()) {
      if (k <= seq) p.arrivalTicks.delete(k);
    }
    p.lastSeq = seq;
    p.lastSeqTick = sim.tick;
  } else {
    cmd = { ...sp.lastCmd, seq: p.lastSeq };
  }

  const locked = sp.dead || sim.phase !== "playing" || cmd.seq === 0;
  sim.applyInput(p.slot, cmd, { locked, bufferWait: sim.tick - p.lastArrivalTick });
}

// --- Round flow -----------------------------------------------------------------

async function stepPhase(): Promise<void> {
  if (SANDBOX) {
    // Endless round: the test environment never resets the world.
    sim.phaseEndTick = sim.tick + ROUND_TICKS;
    return;
  }
  if (sim.phase === "playing") {
    if (
      players.size > 0 &&
      (sim.tick >= sim.phaseEndTick || sim.scores[0] <= 0 || sim.scores[1] <= 0)
    ) {
      sim.phase = "results";
      sim.phaseEndTick = sim.tick + RESULTS_TICKS;
      broadcast({
        type: "phase",
        phase: sim.phase,
        phaseEndTick: sim.phaseEndTick,
        scores: [sim.scores[0], sim.scores[1]],
        mapEpoch,
        mapSeed,
      });
    } else if (players.size === 0 && sim.tick >= sim.phaseEndTick) {
      sim.phaseEndTick = sim.tick + ROUND_TICKS; // idle server: keep pushing the clock
    }
  } else if (sim.tick >= sim.phaseEndTick) {
    await resetRound();
  }
}

async function resetRound(): Promise<void> {
  mapEpoch++;
  mapSeed = pickMapSeed();
  initMap(mapSeed); // a brand-new level; sim.reset() rebuilds physics from it
  await sim.reset();
  botNav = null;
  for (const p of players.values()) {
    p.pending.clear();
    if (p.bot) {
      p.bot.path = [];
      p.bot.pathIdx = 0;
      p.bot.pathTargetX = Number.NaN;
      p.bot.pathTargetY = Number.NaN;
      p.bot.pathTargetZ = Number.NaN;
      p.bot.pathRefreshAtTick = 0;
      p.bot.pathVersion = 0;
      p.bot.repathAtTick = 0;
      p.bot.moveX = 0;
      p.bot.moveZ = 0;
      p.bot.desiredYaw = p.bot.aimYaw;
      p.bot.desiredPitch = 0;
      p.bot.fireIntent = false;
      p.bot.meleeIntent = false;
      p.bot.jumpIntent = false;
      p.bot.grenadeIntent = false;
      p.bot.reloadIntent = false;
      p.bot.sprintIntent = false;
    }
  }
  broadcast({
    type: "phase",
    phase: sim.phase,
    phaseEndTick: sim.phaseEndTick,
    scores: [sim.scores[0], sim.scores[1]],
    mapEpoch,
    mapSeed,
  });
}

// --- Outbound ---------------------------------------------------------------------------

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
  for (const p of all) {
    const sp = simOf(p);
    readChar(sp.body, sp.state);
  }

  const zoneSnaps: ZoneSnap[] = sim.zones.map((zn) => ({ owner: zn.owner, v: Math.round(zn.v) }));
  const chunkSnaps: ChunkSnap[] = [];
  for (const f of sim.falling.values()) {
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

  const entities: EntitySnap[] = sim.grenades.map((g) => {
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
    const self = simOf(p);
    const remotes: RemoteSnap[] = [];
    for (const q of all) {
      if (q === p) continue;
      const sq = simOf(q);
      let flags = 0;
      if (sq.team === 1) flags |= RF_TEAM;
      if (sq.state.onGround) flags |= RF_GROUND;
      if (sq.dead) flags |= RF_DEAD;
      if (sq.lastCmd.crouch) flags |= RF_CROUCH;
      else if (sq.lastCmd.sprint) flags |= RF_SPRINT;
      if (sq.state.reloadTicks > 0) flags |= RF_RELOADING;
      if (sim.tick < sq.protectUntilTick) flags |= RF_PROTECTED;
      remotes.push({
        idx: q.slot,
        flags,
        weapon: packWeaponByte(
          sq.state.slot === 1 ? secondaryIdxFor(sq.state.primary) : sq.state.primary,
          sq.state.primary,
        ),
        x: sq.state.x,
        y: sq.state.y,
        z: sq.state.z,
        yaw: sq.lastCmd.yaw,
        pitch: sq.lastCmd.pitch,
      });
    }
    let status = 0;
    if (self.dead) status |= SS_DEAD;
    if (sim.tick < self.protectUntilTick) status |= SS_PROTECTED;
    const packet = encodeSnapshot({
      serverTick: sim.tick,
      phase: sim.phase === "playing" ? 0 : 1,
      phaseEndTick: sim.phaseEndTick,
      tickets: [sim.scores[0], sim.scores[1]],
      zones: zoneSnaps,
      chunks: chunkSnaps,
      self: {
        ackSeq: p.lastSeq,
        ackTick: p.lastSeqTick,
        status,
        bufferDepth: p.lastDepth,
        hp: self.hp,
        respawnTicks: self.dead ? Math.max(0, self.respawnAtTick - sim.tick) : 0,
        state: self.state,
      },
      remotes,
      entities,
      events: [...sim.events],
    });
    server.datagrams.send(p.conn.id, packet);
  }
}
