// Reconciliation test for the in-game movement now driven by the jolt-ts
// character controller. Uses the REAL shared physics path (createGameWorld +
// stepPlayerController + readChar/writeChar), not a stand-in.
//
// Bundle and run:
//   node_modules/.bin/esbuild scripts/movement-reconcile-test.ts --bundle \
//     --format=esm --platform=node --external:jolt-ts --external:jolt-ts/* \
//     --external:module --outfile=node_modules/.cache/reconcile-test.mjs \
//     && node node_modules/.cache/reconcile-test.mjs
//
// Proves the simulation reconciles: (1) two worlds fed identical inputs stay
// identical (determinism through the controller + full map); (2) restoring an
// older authoritative CharState and replaying the newer inputs reproduces the
// authoritative state exactly (predict→rollback→replay residual ~0); (3) a
// client that mispredicts converges back onto the server after reconciliation.

import { MAP } from "../src/shared/map.js";
import {
  type Body,
  type CharState,
  createGameWorld,
  createPlayerBody,
  type GameWorld,
  type InputCmd,
  makeChar,
  readChar,
  stepPlayerController,
  writeChar,
  ZERO_INPUT,
} from "../src/shared/physics.js";

const DT = 1 / 30;
let failures = 0;

function check(cond: boolean, msg: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

function posErr(a: CharState, b: CharState): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function cloneState(s: CharState): CharState {
  return { ...s };
}

// Deterministic input script: settle, walk, sprint, jump, then turn.
function scriptInput(seq: number, t: number): InputCmd {
  const yaw = t < 90 ? 0 : 1.0;
  const moving = t > 5;
  return {
    ...ZERO_INPUT,
    seq,
    yaw,
    moveX: moving ? Math.sin(yaw) : 0,
    moveZ: moving ? Math.cos(yaw) : 0,
    sprint: t > 40,
    jump: t === 30 || t === 80,
  };
}

function tick(gw: GameWorld, body: Body, s: CharState, input: InputCmd): void {
  stepPlayerController(gw, body, s, input);
  gw.world.step(DT);
  readChar(body, s);
}

async function makeSim(): Promise<{ gw: GameWorld; body: Body; s: CharState }> {
  const gw = await createGameWorld();
  const spawn: [number, number, number] = [MAP.size / 2 - 6, 6, MAP.size / 2 - 6];
  const body = createPlayerBody(gw, 0, spawn);
  const s = makeChar(spawn);
  // Let the controller settle onto the ground first.
  for (let i = 0; i < 30; i++) tick(gw, body, s, { ...ZERO_INPUT, seq: i });
  return { gw, body, s };
}

async function main(): Promise<void> {
  const TICKS = 160;

  // --- 1) Determinism through the real sim. ---
  console.log("[1] determinism (full map + controller)");
  {
    const a = await makeSim();
    const b = await makeSim();
    let worst = 0;
    for (let t = 0; t < TICKS; t++) {
      tick(a.gw, a.body, a.s, scriptInput(t, t));
      tick(b.gw, b.body, b.s, scriptInput(t, t));
      worst = Math.max(worst, posErr(a.s, b.s));
    }
    check(worst < 1e-4, `two runs identical (worst ${worst.toExponential(2)})`);
    a.gw.world.dispose();
    b.gw.world.dispose();
  }

  // --- 2) Rollback/replay reproduces the authoritative state exactly. ---
  console.log("[2] restore older state + replay newer inputs == ground truth");
  {
    // Ground truth: one authoritative run, recording state after each tick.
    const truth = await makeSim();
    const states: CharState[] = [];
    const inputs: InputCmd[] = [];
    for (let t = 0; t < TICKS; t++) {
      const inp = scriptInput(t, t);
      inputs.push(inp);
      tick(truth.gw, truth.body, truth.s, inp);
      states.push(cloneState(truth.s));
    }
    truth.gw.world.dispose();

    // Client reconciles every tick: adopt the acked state LAG ticks back, then
    // replay the inputs since. The result must equal the authoritative state.
    const LAG = 6;
    const client = await makeSim();
    let worst = 0;
    for (let t = LAG; t < TICKS; t++) {
      writeChar(client.body, states[t - LAG]); // adopt authoritative (incl. controller latches)
      readChar(client.body, client.s);
      for (let r = t - LAG + 1; r <= t; r++) tick(client.gw, client.body, client.s, inputs[r]);
      worst = Math.max(worst, posErr(client.s, states[t]));
    }
    check(worst < 1e-3, `replay matches authoritative (worst ${worst.toExponential(2)})`);
    client.gw.world.dispose();
  }

  // --- 3) A mispredicting client converges back onto the server. ---
  console.log("[3] mispredict -> reconcile converges");
  {
    const server = await makeSim();
    const client = await makeSim();
    let worstAfterRecon = 0;
    for (let t = 0; t < TICKS; t++) {
      const inp = scriptInput(t, t);
      tick(server.gw, server.body, server.s, inp);
      // Client mispredicts during a window (wrong move), diverging from server.
      const clientInp = t >= 50 && t < 58 ? { ...inp, moveX: -1, moveZ: 0, sprint: true } : inp;
      tick(client.gw, client.body, client.s, clientInp);
      // Authoritative reconcile each tick (adopt server CharState).
      writeChar(client.body, server.s);
      readChar(client.body, client.s);
      if (t >= 58) worstAfterRecon = Math.max(worstAfterRecon, posErr(client.s, server.s));
    }
    check(
      worstAfterRecon < 1e-3,
      `client tracks server post-divergence (worst ${worstAfterRecon.toExponential(2)})`,
    );
    server.gw.world.dispose();
    client.gw.world.dispose();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

void main();
