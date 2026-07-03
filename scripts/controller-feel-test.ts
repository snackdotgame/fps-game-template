// Validates the SHIPPED character-controller feel through the real shared
// physics path (createGameWorld + createPlayerBody + stepPlayerController +
// readChar) — the same code the client and server run. Confirms the two bugs
// are fixed: (1) no vertical bob while standing still, (2) the player falls at
// the world's GRAVITY, not the controller's amplified fallingGravityScale.
//
//   npm run test:controller

import { heightAt, MAP, spawnPoint } from "../src/shared/map.js";
import {
  type Body,
  type CharState,
  createGameWorld,
  createPlayerBody,
  GRAVITY,
  type GameWorld,
  type InputCmd,
  makeChar,
  readChar,
  stepPlayerController,
  ZERO_INPUT,
} from "../src/shared/physics.js";

const DT = 1 / 30;
let failures = 0;

function tick(
  gw: GameWorld,
  body: Body,
  s: CharState,
  seq: number,
  over: Partial<InputCmd> = {},
): void {
  stepPlayerController(gw, body, s, { ...ZERO_INPUT, seq, ...over });
  gw.world.step(DT);
  readChar(body, s);
}

async function main(): Promise<void> {
  // --- Standing-still bob (the "rises and falls continuously" bug) ---
  {
    const gw = await createGameWorld();
    const spawn: [number, number, number] = [MAP.size / 2 - 6, 3, MAP.size / 2 - 6];
    const body = createPlayerBody(gw, 0, spawn);
    const s = makeChar(spawn);
    const ys: number[] = [];
    for (let t = 0; t < 240; t++) {
      tick(gw, body, s, t);
      ys.push(s.y);
    }
    const groundFeet = ys[ys.length - 1];
    const tail = ys.slice(-120); // last 4 s, fully settled
    const bob = Math.max(...tail) - Math.min(...tail);
    const terrain = heightAt(spawn[0], spawn[2]);
    const hover = groundFeet - terrain;
    console.log("== standing still (real game path) ==");
    console.log(
      `  settled feetY=${groundFeet.toFixed(4)}  terrainY=${terrain.toFixed(4)}  feet-above-ground=${(hover * 1000).toFixed(1)} mm`,
    );
    console.log(`  bob over last 4s = ${(bob * 1000).toFixed(2)} mm`);
    const ok = bob < 0.002 && Math.abs(hover) < 0.02;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"} (want bob<2mm AND feet on ground; old bob ~400mm)`);
    gw.world.dispose();
  }

  // --- Crouch locomotion speed ---
  {
    const gw = await createGameWorld();
    const spawn = spawnPoint(0, 0);
    const body = createPlayerBody(gw, 0, spawn);
    const s = makeChar(spawn);
    for (let t = 0; t < 90; t++) tick(gw, body, s, t); // settle on the ground
    // Peak speed over the run: the walker eventually leaves the flat spawn
    // pad and slows on the cradle-hill climb, so the tail sample is terrain
    // luck — the flat-ground cruise (and the cap) is what crouch tunes.
    let peak = 0;
    for (let t = 90; t < 170; t++) {
      tick(gw, body, s, t, { moveZ: 1, crouch: true });
      peak = Math.max(peak, Math.hypot(s.vx, s.vz));
    }
    console.log("\n== crouch locomotion (real game path) ==");
    console.log(`  peak crouch speed = ${peak.toFixed(2)} m/s`);
    const ok = peak > 2.2 && peak < 3.0;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"} (want ~2.6 m/s cruise, well under the 5.2 walk)`);
    gw.world.dispose();
  }

  // --- Fall acceleration (the "gravity feels heavy" bug) ---
  {
    const gw = await createGameWorld();
    const spawn: [number, number, number] = [MAP.size / 2, 40, MAP.size / 2];
    const body = createPlayerBody(gw, 0, spawn);
    const s = makeChar(spawn);
    for (let t = 0; t < 10; t++) tick(gw, body, s, t);
    const effG = -s.vy / (10 * DT);
    console.log("\n== free fall (real game path) ==");
    console.log(
      `  vy after 10 ticks = ${s.vy.toFixed(2)} m/s  -> effective gravity ${effG.toFixed(1)} m/s^2`,
    );
    const ok = Math.abs(effG - GRAVITY) < 2;
    if (!ok) failures++;
    console.log(
      `  world GRAVITY=${GRAVITY}. ${ok ? "PASS" : "FAIL"} (old fallingGravityScale=3 gave ~61 m/s^2)`,
    );
    gw.world.dispose();
  }

  // --- Jump apex (JUMP_VEL retuned with GRAVITY to keep jump height) ---
  {
    const gw = await createGameWorld();
    const spawn: [number, number, number] = [MAP.size / 2 - 6, 3, MAP.size / 2 - 6];
    const body = createPlayerBody(gw, 0, spawn);
    const s = makeChar(spawn);
    for (let t = 0; t < 90; t++) tick(gw, body, s, t); // settle on the ground
    const groundFeet = s.y;
    tick(gw, body, s, 90, { jump: true }); // press jump for one tick
    let apex = s.y;
    for (let t = 91; t < 140; t++) {
      tick(gw, body, s, t); // release; ride the arc back down
      apex = Math.max(apex, s.y);
    }
    const height = apex - groundFeet;
    console.log("\n== jump apex (real game path) ==");
    console.log(`  jump height = ${height.toFixed(3)} m`);
    const ok = Math.abs(height - 1.38) < 0.12;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"} (want ~1.38 m, same height as the old g=22 jump)`);
    gw.world.dispose();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

void main();
