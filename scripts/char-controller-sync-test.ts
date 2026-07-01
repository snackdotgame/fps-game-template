// Determinism + client/server sync test for the jolt-ts character controller's
// binary state codec (src/shared/charControllerState.ts).
//
// Bundle and run:
//   node_modules/.bin/esbuild scripts/char-controller-sync-test.ts --bundle \
//     --format=esm --platform=node --external:module \
//     --outfile=/tmp/cc-sync-test.mjs && node /tmp/cc-sync-test.mjs
//
// Proves: (1) the binary form round-trips to float32 precision; (2) the
// controller is deterministic (identical state + inputs => identical result, so
// a client can predict the server); (3) applySyncState restores a controller
// exactly from the bytes; (4) after a divergence, feeding the server's bytes to
// the client snaps it back onto the server.

import { Shape, World } from "jolt-ts";
import { CharacterController } from "jolt-ts-character-controller";
import {
  CHAR_STATE_BYTES,
  decodeCharControllerState,
  encodeCharControllerState,
} from "../src/shared/charControllerState.js";

const DT = 1 / 60;
let failures = 0;

function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

function dist(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

async function makeWorld(): Promise<World> {
  const world = await World.create({ gravity: [0, -9.81, 0], deterministic: "cross-platform" });
  world.createBody({
    type: "static",
    shape: Shape.box({ halfExtents: [60, 0.5, 60] }),
    position: [0, -0.5, 0],
    layer: "static",
    friction: 0.8,
  });
  return world;
}

function makeController(world: World): CharacterController {
  return new CharacterController({
    world,
    position: [0, 1, 0],
    enableToggleRun: false,
    autoBalance: false,
  });
}

// A deterministic per-tick input script: idle, walk, run, jump, then turn.
function scriptedInput(tick: number): {
  forward: boolean;
  run: boolean;
  jump: boolean;
  yaw: number;
} {
  return {
    forward: tick > 5,
    run: tick > 70,
    jump: tick === 40 || tick === 110,
    yaw: tick < 130 ? 0 : Math.PI / 2,
  };
}

function drive(
  ctrl: CharacterController,
  world: World,
  input: { forward: boolean; run: boolean; jump: boolean; yaw: number },
): void {
  ctrl.setForwardDirection(
    { x: Math.sin(input.yaw), y: 0, z: Math.cos(input.yaw) },
    { x: 0, y: 1, z: 0 },
  );
  ctrl.setMovement({ forward: input.forward, run: input.run, jump: input.jump });
  ctrl.step(DT);
  world.step(DT);
}

async function main(): Promise<void> {
  const TICKS = 220;

  // --- 1) Binary round-trips to float32 precision over a real trajectory. ---
  console.log("[1] binary round-trip");
  {
    const world = await makeWorld();
    const ctrl = makeController(world);
    let worstPos = 0;
    let sizeOk = true;
    for (let t = 0; t < TICKS; t++) {
      drive(ctrl, world, scriptedInput(t));
      const before = ctrl.getSyncState();
      const bytes = encodeCharControllerState(before);
      if (bytes.length !== CHAR_STATE_BYTES) sizeOk = false;
      const after = decodeCharControllerState(bytes);
      worstPos = Math.max(worstPos, dist(before.position, after.position));
      // re-encoding the decoded state must be byte-identical (stable codec)
      const reBytes = encodeCharControllerState(after);
      if (bytes.some((b, i) => b !== reBytes[i])) sizeOk = false;
    }
    check(sizeOk, `${CHAR_STATE_BYTES}-byte frames, stable re-encode`);
    check(
      worstPos < 1e-3,
      `position round-trip within float32 (worst ${worstPos.toExponential(2)})`,
    );
    world.dispose();
  }

  // --- 2) Determinism: identical inputs => identical trajectory (no sync). ---
  console.log("[2] determinism");
  {
    const wa = await makeWorld();
    const ca = makeController(wa);
    const wb = await makeWorld();
    const cb = makeController(wb);
    let worst = 0;
    for (let t = 0; t < TICKS; t++) {
      drive(ca, wa, scriptedInput(t));
      drive(cb, wb, scriptedInput(t));
      worst = Math.max(worst, dist(ca.getSyncState().position, cb.getSyncState().position));
    }
    check(worst < 1e-6, `two runs stay identical (worst drift ${worst.toExponential(2)})`);
    wa.dispose();
    wb.dispose();
  }

  // --- 3) applySyncState restores a controller exactly from the bytes. ---
  console.log("[3] restore from bytes");
  {
    const ws = await makeWorld();
    const cs = makeController(ws);
    for (let t = 0; t < 120; t++) drive(cs, ws, scriptedInput(t));
    const bytes = encodeCharControllerState(cs.getSyncState());

    const wc = await makeWorld();
    const cc = makeController(wc);
    for (let t = 0; t < 30; t++) drive(cc, wc, { forward: true, run: true, jump: false, yaw: 1 }); // somewhere else
    const wire = decodeCharControllerState(bytes);
    cc.applySyncState(wire);
    const restored = cc.getSyncState();
    check(dist(restored.position, wire.position) < 1e-4, "position restored");
    check(dist(restored.linearVelocity, wire.linearVelocity) < 1e-4, "velocity restored");
    check(
      restored.onGround === wire.onGround && restored.canJump === wire.canJump,
      "latches restored",
    );
    ws.dispose();
    wc.dispose();
  }

  // --- 4) End-to-end: client diverges, then the server's bytes snap it back. ---
  console.log("[4] client/server reconcile over the wire");
  {
    const wServer = await makeWorld();
    const server = makeController(wServer);
    const wClient = await makeWorld();
    const client = makeController(wClient);

    let worstSynced = 0;
    for (let t = 0; t < TICKS; t++) {
      drive(server, wServer, scriptedInput(t));
      // Client mispredicts during a window (wrong input) to force divergence.
      const clientInput =
        t >= 50 && t < 60 ? { forward: false, run: false, jump: true, yaw: 2.5 } : scriptedInput(t);
      drive(client, wClient, clientInput);
      // Server is authoritative: ship its state as bytes, client adopts it.
      client.applySyncState(
        decodeCharControllerState(encodeCharControllerState(server.getSyncState())),
      );
      worstSynced = Math.max(
        worstSynced,
        dist(client.getSyncState().position, server.getSyncState().position),
      );
    }
    check(
      worstSynced < 1e-3,
      `client tracks server through divergence (worst ${worstSynced.toExponential(2)})`,
    );
    wServer.dispose();
    wClient.dispose();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

void main();
