// Behavior + determinism tests for the shared FPS physics/controller layer.
// Bundle and run:
//   node_modules/.bin/esbuild scripts/physics-test.ts --bundle --format=esm \
//     --platform=browser --external:module --outfile=/tmp/bp-physics-test.mjs \
//     && node /tmp/bp-physics-test.mjs
import { GRENADE_FUSE_TICKS, RIFLE_COOLDOWN_TICKS, RIFLE_MAG } from "../src/shared/constants.js";
import { MAP, spawnPoint } from "../src/shared/map.js";
import { quantizeAngle, quantizeMove } from "../src/shared/netCodec.js";
import {
  type Body,
  buildPlacement,
  type CharState,
  createGameWorld,
  createGrenadeBody,
  createPlayerBody,
  destroyGameWorld,
  DT,
  type GameWorld,
  type InputCmd,
  makeChar,
  readChar,
  removePanelBody,
  type StepHooks,
  stepPlayerController,
  writeChar,
  ZERO_INPUT,
} from "../src/shared/physics.js";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
}

function cmd(seq: number, over: Partial<InputCmd> = {}): InputCmd {
  return { seq, ...ZERO_INPUT, ...over };
}

interface Rig {
  gw: GameWorld;
  body: Body;
  s: CharState;
}

async function rig(feet: readonly number[]): Promise<Rig> {
  const gw = await createGameWorld();
  const body = createPlayerBody(gw, 0, feet);
  return { gw, body, s: makeChar(feet) };
}

function step(r: Rig, input: InputCmd, hooks: StepHooks = {}, locked = false): void {
  stepPlayerController(r.gw, r.body, r.s, input, { ...hooks, locked });
  r.gw.world.step(DT);
  readChar(r.body, r.s);
}

async function main(): Promise<void> {
  const spawn = spawnPoint(0, 0);

  // --- Settle. ---
  {
    const r = await rig(spawn);
    for (let t = 0; t < 60; t++) step(r, cmd(t + 1));
    check("settles on ground", r.s.onGround && Math.abs(r.s.y) < 0.035, `y=${r.s.y}`);
    destroyGameWorld(r.gw);
  }

  // --- Walk + sprint speeds. ---
  {
    // Head +x along the south edge — the only long open lane from spawn.
    const r = await rig(spawn);
    const east = quantizeAngle(Math.PI / 2);
    for (let t = 0; t < 45; t++) step(r, cmd(t + 1, { moveX: quantizeMove(1), yaw: east }));
    const walk = Math.hypot(r.s.vx, r.s.vz);
    check("walk speed ~5.2", walk > 4.6 && walk < 5.4, `v=${walk}`);
    for (let t = 45; t < 90; t++) {
      step(r, cmd(t + 1, { moveX: quantizeMove(1), sprint: true, yaw: east }));
    }
    const sprint = Math.hypot(r.s.vx, r.s.vz);
    check("sprint speed ~7.6", sprint > 6.9 && sprint < 7.9, `v=${sprint}`);
    destroyGameWorld(r.gw);
  }

  // --- Jump. ---
  {
    const r = await rig(spawn);
    for (let t = 0; t < 30; t++) step(r, cmd(t + 1));
    let peak = 0;
    for (let t = 30; t < 90; t++) {
      step(r, cmd(t + 1, { jump: t === 30 }));
      peak = Math.max(peak, r.s.y);
    }
    check("jump peak ~1m", peak > 0.7 && peak < 1.4, `peak=${peak}`);
    check("lands after jump", r.s.onGround, `y=${r.s.y}`);
    destroyGameWorld(r.gw);
  }

  // --- Firing: cadence, ammo, reload. ---
  {
    const r = await rig(spawn);
    for (let t = 0; t < 30; t++) step(r, cmd(t + 1));
    let shots = 0;
    for (let t = 30; t < 90; t++) {
      step(r, cmd(t + 1, { fire: true }), { onFire: () => shots++ });
    }
    const expected = Math.ceil(60 / RIFLE_COOLDOWN_TICKS);
    check(
      "full-auto cadence",
      Math.abs(shots - expected) <= 1,
      `shots=${shots} expected~${expected}`,
    );
    check("ammo decrements", r.s.ammo === RIFLE_MAG - shots, `ammo=${r.s.ammo}`);
    let t2 = 90;
    step(r, cmd(++t2, { reload: true }));
    check("reload starts", r.s.reloadTicks > 0, "");
    for (let i = 0; i < 60; i++) step(r, cmd(++t2));
    check("reload refills mag", r.s.ammo === RIFLE_MAG, `ammo=${r.s.ammo}`);
    destroyGameWorld(r.gw);
  }

  // --- Grenade throw decrements and fires the hook. ---
  {
    const r = await rig(spawn);
    for (let t = 0; t < 30; t++) step(r, cmd(t + 1));
    let thrown = 0;
    let vel: number[] = [];
    step(r, cmd(31, { grenade: true, pitch: quantizeAngle(0.4) }), {
      onGrenade: (_o, v) => {
        thrown++;
        vel = [...v];
      },
    });
    check("grenade hook fires", thrown === 1 && r.s.grenades === 1, `g=${r.s.grenades}`);
    check("grenade goes up-forward", vel[1] > 3 && Math.hypot(vel[0], vel[2]) > 10, `${vel}`);
    destroyGameWorld(r.gw);
  }

  // --- Build placement lands in front, supply decrements. ---
  {
    const r = await rig(spawn);
    for (let t = 0; t < 30; t++) step(r, cmd(t + 1));
    const placement = buildPlacement(r.s, 0);
    check(
      "build placement in front",
      Math.abs(placement.z - (r.s.z + 3)) < 0.6 && placement.orient === "x",
      JSON.stringify(placement),
    );
    let built = 0;
    step(r, cmd(31, { build: true }), { onBuild: () => built++ });
    check("build hook + supply", built === 1 && r.s.supply === 5, `supply=${r.s.supply}`);
    destroyGameWorld(r.gw);
  }

  // --- Breaching: a wall blocks rays until its panel is removed. ---
  {
    const gw = await createGameWorld();
    // The center building's south wall sits at z = -4; shoot it from outside.
    const hit1 = gw.world.castRay([0.2, 0.6, -8], [0, 0, 6]);
    const tag1 = (hit1?.body?.userData ?? {}) as { panelId?: number };
    check(
      "wall blocks the shot",
      hit1 !== null && tag1.panelId !== undefined,
      JSON.stringify(tag1),
    );
    if (tag1.panelId !== undefined) {
      removePanelBody(gw, tag1.panelId);
      const hit2 = gw.world.castRay([0.2, 0.6, -8], [0, 0, 6]);
      const tag2 = (hit2?.body?.userData ?? {}) as { panelId?: number };
      check(
        "breached wall lets shots through",
        hit2 === null || tag2.panelId !== tag1.panelId,
        JSON.stringify(tag2),
      );
    }
    destroyGameWorld(gw);
  }

  // --- Grenade body flies and bounces. ---
  {
    const gw = await createGameWorld();
    const body = createGrenadeBody(gw, 1, [-22, 1.5, -20], [8, 2, 0]);
    let minY = 10;
    let bounced = false;
    let prevVy = 0;
    for (let t = 0; t < GRENADE_FUSE_TICKS; t++) {
      gw.world.step(DT);
      const pos = body.translation();
      const vel = body.linearVelocity();
      minY = Math.min(minY, pos.y);
      if (prevVy < -1 && vel.y > 0.5) bounced = true;
      prevVy = vel.y;
    }
    const end = body.translation();
    check("grenade travels", end.x > -14, `x=${end.x}`);
    check("grenade bounces", bounced, `minY=${minY}`);
    destroyGameWorld(gw);
  }

  // --- Determinism: identical scripted runs are bit-exact. ---
  {
    const run = async (): Promise<string> => {
      const r = await rig(spawnPoint(0, 2));
      const parts: number[] = [];
      for (let t = 0; t < 500; t++) {
        step(
          r,
          cmd(t + 1, {
            moveX: quantizeMove(Math.sin(t / 19)),
            moveZ: quantizeMove(Math.cos(t / 29)),
            yaw: quantizeAngle(Math.sin(t / 47) * 3),
            jump: t % 41 === 0,
            sprint: t % 3 === 0,
            fire: t % 7 === 0,
          }),
        );
        if (t % 10 === 0) parts.push(r.s.x, r.s.y, r.s.z, r.s.vx, r.s.vy, r.s.vz, r.s.ammo);
      }
      destroyGameWorld(r.gw);
      return parts.map((v) => v.toFixed(17)).join(",");
    };
    const a = await run();
    const b = await run();
    check("bit-exact determinism over 500 ticks", a === b);
  }

  // --- Restore+replay converges (the reconciliation primitive). ---
  {
    const r = await rig(spawnPoint(0, 2));
    const inputs: InputCmd[] = [];
    for (let t = 0; t < 200; t++) {
      inputs.push(
        cmd(t + 1, {
          moveX: quantizeMove(Math.sin(t / 19)),
          moveZ: quantizeMove(Math.cos(t / 29)),
          jump: t % 41 === 0,
        }),
      );
    }
    for (let t = 0; t < 100; t++) step(r, inputs[t]);
    const mid = { ...r.s };
    for (let t = 100; t < 200; t++) step(r, inputs[t]);
    const end = { x: r.s.x, y: r.s.y, z: r.s.z };
    Object.assign(r.s, mid);
    writeChar(r.body, r.s);
    for (let t = 100; t < 200; t++) step(r, inputs[t]);
    const err = Math.hypot(r.s.x - end.x, r.s.y - end.y, r.s.z - end.z);
    check("restore+replay converges (<2cm/100 ticks)", err < 0.02, `err=${err}`);
    destroyGameWorld(r.gw);
  }

  console.log(`\nmap: ${MAP.panels.length} destructible panels, ${MAP.statics.length} statics`);
  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all physics tests passed");
}

void main();
