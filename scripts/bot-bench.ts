// Headless bot benchmark for the authoritative server-side sim.
//
// This intentionally mirrors the current src/server.ts bot loop so optimization
// patches can be measured one at a time before they are promoted to gameplay.
//
// Run:
//   node_modules/.bin/esbuild scripts/bot-bench.ts --bundle --format=esm \
//     --platform=browser --external:module --outfile=/tmp/fps-bot-bench.mjs \
//     && node /tmp/fps-bot-bench.mjs

import { BOT_FILL, TICK_RATE } from "../src/shared/constants.js";
import { heightAt, MAP, ZONES } from "../src/shared/map.js";
import { BotNav, initBotNav, type BotNavPoint } from "../src/server/botNav.js";
import {
  aimDirection,
  destroyGameWorld,
  eyePosition,
  type InputCmd,
  makeChar,
  readChar,
  writeChar,
} from "../src/shared/physics.js";
import { GameSim, type SimPlayer } from "../src/shared/sim.js";

const BOT_DECISION_INTERVAL = 6;
const BOT_TARGET_VISIBILITY_TICKS = BOT_DECISION_INTERVAL + 2;
const BOT_STUCK_CHECK_INTERVAL = 45;

interface BotBrain {
  wanderX: number;
  wanderY: number;
  wanderZ: number;
  repathAtTick: number;
  targetIdx: number;
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

interface BenchPlayer {
  bot: BotBrain;
  slot: number;
  lastSeq: number;
}

interface Counters {
  losChecks: number;
  raycasts: number;
  stuckChecks: number;
}

interface Sample {
  sample: number;
  scenario: string;
  ticks: number;
  bots: number;
  avgTickMs: number;
  worstTickMs: number;
  avgInputBotsMs: number;
  avgPhysicsMs: number;
  losChecksPerTick: number;
  raycastsPerTick: number;
  stuckChecksPerTick: number;
  destroyedPanels: number;
  builtPanels: number;
  grenades: number;
  kills: number;
  deaths: number;
}

const measuredTicks = Number(process.env.BOT_BENCH_TICKS ?? 1200);
const warmupTicks = Number(process.env.BOT_BENCH_WARMUP ?? 300);
const samples = Number(process.env.BOT_BENCH_SAMPLES ?? 3);
const scenario = process.env.BOT_BENCH_SCENARIO ?? "match";
const navEnabled = process.env.BOT_BENCH_NAV !== "0";
let botNav: BotNav | null = null;

function makeBot(sim: GameSim, slot: number, team: number): BenchPlayer {
  const sp = sim.addPlayer(slot, team);
  return {
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
      stuckCheckAt: initialBotStuckCheckTick(sim, slot),
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
    lastSeq: 0,
  };
}

function shortestArc(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function navForBots(): BotNav | null {
  if (!navEnabled) return null;
  botNav ??= new BotNav();
  return botNav;
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
  sim: GameSim,
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

function botThink(
  sim: GameSim,
  p: SimPlayer,
  b: BotBrain,
  lastSeq: number,
  counters: Counters,
): InputCmd {
  if (shouldUpdateBotDecision(sim, p.idx)) updateBotDecision(sim, p, b, counters);
  return makeBotInput(sim, p, b, lastSeq);
}

function shouldUpdateBotDecision(sim: GameSim, slot: number): boolean {
  return sim.tick % BOT_DECISION_INTERVAL === slot % BOT_DECISION_INTERVAL;
}

function updateBotDecision(sim: GameSim, p: SimPlayer, b: BotBrain, counters: Counters): void {
  const tick = sim.tick;
  const rng = sim.rng;
  readChar(p.body, p.state);
  const s = p.state;
  const eye = eyePosition(s);

  const current = b.targetIdx >= 0 ? sim.player(b.targetIdx) : null;
  if (current && !current.dead && hasLineOfSight(sim, p, current, counters)) {
    b.targetVisibleUntilTick = tick + BOT_TARGET_VISIBILITY_TICKS;
  } else {
    b.targetIdx = -1;
    b.targetVisibleUntilTick = 0;
    let bestDist = 42;
    for (const q of sim.players) {
      if (!q || q.team === p.team || q.dead) continue;
      readChar(q.body, q.state);
      const d = Math.hypot(q.state.x - s.x, q.state.z - s.z);
      if (d < bestDist && hasLineOfSight(sim, p, q, counters)) {
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
    const wobble = 0.012 + dist * 0.0011;
    desiredYaw = Math.atan2(dx, dz) + (rng() - 0.5) * 2 * wobble;
    desiredPitch = Math.atan2(target.state.y + 1.0 - eye[1], dist) + (rng() - 0.5) * wobble;
    if (tick >= b.pauseUntil && b.burstUntil <= tick) {
      b.burstUntil = tick + 6 + Math.floor(rng() * 8);
      b.pauseUntil = b.burstUntil + 5 + Math.floor(rng() * 10);
    }
    fire = tick < b.burstUntil;
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
    const toX = b.wanderX - s.x;
    const toZ = b.wanderZ - s.z;
    if (tick >= b.repathAtTick || Math.hypot(toX, toZ) < 2) {
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
        const randomPoint = navForBots()?.randomPoint(sim, rng);
        if (randomPoint && rng() < 0.65) {
          setBotDestination(b, randomPoint[0], randomPoint[1], randomPoint[2]);
        } else {
          const half = MAP.size / 2 - 6;
          let x = (rng() * 2 - 1) * half;
          let z = (rng() * 2 - 1) * half;
          const enemySpawnZ = p.team === 0 ? 100 : -100;
          if (Math.abs(z - enemySpawnZ) < 15 && Math.abs(x) < 15) {
            z = enemySpawnZ - Math.sign(enemySpawnZ) * (16 + rng() * 12);
          }
          setBotDestination(b, x, heightAt(x, z) + 0.15, z);
        }
      }
      b.repathAtTick = tick + 240 + Math.floor(rng() * 240);
    }
    const steer = botSteerDestination(sim, s.x, s.y, s.z, b, rng);
    const len = Math.hypot(steer.x, steer.z) || 1;
    moveX = steer.x / len;
    moveZ = steer.z / len;
    desiredYaw = Math.atan2(moveX, moveZ);
    if (steer.y > s.y + 0.45 && len < 1.5) jump = true;
    sprint = true;
    if (s.ammo < 12) reload = true;
  }

  if (tick >= b.stuckCheckAt) {
    counters.stuckChecks++;
    const moved = Math.hypot(s.x - b.stuckX, s.z - b.stuckZ);
    if (moved < 0.5 && !p.dead && (moveX !== 0 || moveZ !== 0)) {
      const dir = aimDirection(b.aimYaw, 0);
      counters.raycasts++;
      const ahead = sim.gw.world.castRay(
        [eye[0], eye[1] - 0.5, eye[2]],
        [dir[0] * 1.8, 0, dir[2] * 1.8],
      );
      const tag = (ahead?.body?.userData ?? {}) as { panelId?: number; slabIdx?: number };
      if (tag.panelId !== undefined || tag.slabIdx !== undefined) melee = true;
      else jump = true;
      if (rng() < 0.3) b.repathAtTick = 0;
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

function makeBotInput(sim: GameSim, p: SimPlayer, b: BotBrain, lastSeq: number): InputCmd {
  const tick = sim.tick;
  refreshCombatIntent(sim, p, b);
  const turn = 0.22;
  b.aimYaw += Math.max(-turn, Math.min(turn, shortestArc(b.aimYaw, b.desiredYaw)));
  b.aimPitch += Math.max(-turn, Math.min(turn, b.desiredPitch - b.aimPitch));
  const aligned = Math.abs(shortestArc(b.aimYaw, b.desiredYaw)) < 0.07;

  const cmd = {
    seq: lastSeq + 1,
    moveX: b.moveX,
    moveZ: b.moveZ,
    viewTick: tick & 0xffff,
    yaw: b.aimYaw,
    pitch: b.aimPitch,
    jump: b.jumpIntent,
    sprint: b.sprintIntent,
    fire: b.fireIntent && aligned && tick < b.burstUntil && tick <= b.targetVisibleUntilTick,
    reload: b.reloadIntent,
    grenade: b.grenadeIntent,
    melee: b.meleeIntent,
    build: false,
  };
  b.jumpIntent = false;
  b.grenadeIntent = false;
  b.meleeIntent = false;
  return cmd;
}

function refreshCombatIntent(sim: GameSim, p: SimPlayer, b: BotBrain): void {
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

function initialBotStuckCheckTick(sim: GameSim, slot: number): number {
  return sim.tick + 6 + ((slot * 17) % BOT_STUCK_CHECK_INTERVAL);
}

function hasLineOfSight(sim: GameSim, from: SimPlayer, to: SimPlayer, counters: Counters): boolean {
  counters.losChecks++;
  readChar(to.body, to.state);
  const eye = eyePosition(from.state);
  const tx = to.state.x - eye[0];
  const ty = to.state.y + 1.0 - eye[1];
  const tz = to.state.z - eye[2];
  const dist = Math.hypot(tx, ty, tz);
  if (dist < 0.5) return true;
  counters.raycasts++;
  const hit = sim.gw.world.castRay(
    eye,
    [(tx / dist) * (dist + 0.5), (ty / dist) * (dist + 0.5), (tz / dist) * (dist + 0.5)],
    { excludeBody: from.body },
  );
  return hit !== null && hit.body === to.body;
}

async function runSample(sample: number): Promise<Sample> {
  botNav = null;
  const sim = new GameSim(0xbeac4);
  await sim.init();
  if (navEnabled) {
    await initBotNav();
    botNav = new BotNav();
    botNav.warm(sim);
  }
  const players: BenchPlayer[] = [];
  for (let slot = 0; slot < BOT_FILL; slot++) {
    players.push(makeBot(sim, slot, slot % 2));
  }
  if (scenario === "skirmish") placeSkirmish(sim, players);

  const counters: Counters = { losChecks: 0, raycasts: 0, stuckChecks: 0 };
  let inputBotsMs = 0;
  let physicsMs = 0;
  let totalMs = 0;
  let worstTickMs = 0;

  const runTick = (measured: boolean): void => {
    const tickStart = performance.now();
    sim.tick++;
    for (const p of players) {
      const sp = sim.player(p.slot);
      if (!sp) continue;
      const cmd = botThink(sim, sp, p.bot, p.lastSeq, counters);
      p.lastSeq++;
      sim.applyInput(p.slot, cmd, { locked: sp.dead || sim.phase !== "playing", isBot: true });
    }
    const inputEnd = performance.now();
    sim.stepWorld();
    const tickEnd = performance.now();
    sim.outbox.length = 0;
    if (!measured) return;
    inputBotsMs += inputEnd - tickStart;
    physicsMs += tickEnd - inputEnd;
    totalMs += tickEnd - tickStart;
    worstTickMs = Math.max(worstTickMs, tickEnd - tickStart);
  };

  for (let i = 0; i < warmupTicks; i++) runTick(false);
  counters.losChecks = 0;
  counters.raycasts = 0;
  counters.stuckChecks = 0;
  for (let i = 0; i < measuredTicks; i++) runTick(true);
  let kills = 0;
  let deaths = 0;
  for (const player of sim.players) {
    if (!player) continue;
    kills += player.kills;
    deaths += player.deaths;
  }

  const result: Sample = {
    sample,
    scenario,
    ticks: measuredTicks,
    bots: players.length,
    avgTickMs: totalMs / measuredTicks,
    worstTickMs,
    avgInputBotsMs: inputBotsMs / measuredTicks,
    avgPhysicsMs: physicsMs / measuredTicks,
    losChecksPerTick: counters.losChecks / measuredTicks,
    raycastsPerTick: counters.raycasts / measuredTicks,
    stuckChecksPerTick: counters.stuckChecks / measuredTicks,
    destroyedPanels: sim.destroyedPanels.size,
    builtPanels: sim.builtPanels.size,
    grenades: sim.grenades.length,
    kills,
    deaths,
  };
  destroyGameWorld(sim.gw);
  return result;
}

function placeSkirmish(sim: GameSim, players: readonly BenchPlayer[]): void {
  for (const p of players) {
    const sp = sim.player(p.slot);
    if (!sp) continue;
    const lane = Math.floor(p.slot / 2);
    const side = p.slot % 2 === 0 ? -1 : 1;
    const x = side < 0 ? 16 : 32;
    const z = -36 + lane * 4;
    sp.state = makeChar([x, heightAt(x, z) + 0.1, z]);
    writeChar(sp.body, sp.state);
    p.bot.stuckX = sp.state.x;
    p.bot.stuckZ = sp.state.z;
    p.bot.aimYaw = side < 0 ? Math.PI / 2 : -Math.PI / 2;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const results: Sample[] = [];
for (let i = 0; i < samples; i++) {
  const sample = await runSample(i + 1);
  results.push(sample);
  console.log(
    `sample ${sample.sample}: tick=${sample.avgTickMs.toFixed(3)}ms ` +
      `input+bots=${sample.avgInputBotsMs.toFixed(3)}ms physics=${sample.avgPhysicsMs.toFixed(3)}ms ` +
      `los=${sample.losChecksPerTick.toFixed(2)}/tick rays=${sample.raycastsPerTick.toFixed(2)}/tick ` +
      `kills=${sample.kills}`,
  );
}

const summary = {
  ticks: measuredTicks,
  warmupTicks,
  samples,
  scenario,
  navEnabled,
  simSeconds: measuredTicks / TICK_RATE,
  medianAvgTickMs: median(results.map((r) => r.avgTickMs)),
  medianAvgInputBotsMs: median(results.map((r) => r.avgInputBotsMs)),
  medianAvgPhysicsMs: median(results.map((r) => r.avgPhysicsMs)),
  medianLosChecksPerTick: median(results.map((r) => r.losChecksPerTick)),
  medianRaycastsPerTick: median(results.map((r) => r.raycastsPerTick)),
  medianKills: median(results.map((r) => r.kills)),
  medianDeaths: median(results.map((r) => r.deaths)),
  worstTickMs: Math.max(...results.map((r) => r.worstTickMs)),
  results,
};

console.log(`BOT_BENCH_JSON ${JSON.stringify(summary)}`);
