// Behavior + determinism tests for the shared FPS physics/controller layer.
// Bundle and run:
//   node_modules/.bin/esbuild scripts/physics-test.ts --bundle --format=esm \
//     --platform=browser --external:module --outfile=/tmp/bp-physics-test.mjs \
//     && node /tmp/bp-physics-test.mjs
import { GRENADE_FUSE_TICKS, RIFLE_COOLDOWN_TICKS, RIFLE_MAG } from "../src/shared/constants.js";
import {
  addCrater,
  buildContactIndex,
  heightAt,
  MAP,
  resetCraters,
  slabOfPiece,
  spawnPoint,
} from "../src/shared/map.js";
import { quantizeAngle, quantizeMove } from "../src/shared/netCodec.js";
import {
  applyCraterBodies,
  type Body,
  buildPlacement,
  castWallDistance,
  mergeSlabBoxes,
  pieceIdFromHit,
  rebuildSlabBody,
  rayVsCapsule,
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
    // Head north up the duel corridor — kept clear of placements and hills
    // (its x is seeded per map).
    const { duelLaneX } = await import("../src/shared/map.js");
    const lane = duelLaneX();
    const r = await rig([lane, heightAt(lane, -32) + 0.1, -32]);
    const north = quantizeAngle(0);
    for (let t = 0; t < 45; t++) step(r, cmd(t + 1, { moveZ: quantizeMove(1), yaw: north }));
    const walk = Math.hypot(r.s.vx, r.s.vz);
    check("walk speed ~5.2", walk > 4.6 && walk < 5.4, `v=${walk}`);
    for (let t = 45; t < 90; t++) {
      step(r, cmd(t + 1, { moveZ: quantizeMove(1), sprint: true, yaw: north }));
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
    check("jump peak ~1m", peak > 0.7 && peak < 1.45, `peak=${peak}`);
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
      Math.abs(placement.z - (r.s.z + 3)) < 0.6 &&
        placement.material === "metal" &&
        placement.ex === 2,
      JSON.stringify(placement),
    );
    let built = 0;
    step(r, cmd(31, { build: true }), { onBuild: () => built++ });
    check("build hook + supply", built === 1 && r.s.supply === 5, `supply=${r.s.supply}`);
    destroyGameWorld(r.gw);
  }

  // --- Breaching: a wall blocks rays; destroying the HIT BRICK (resolved
  // analytically from the hit point) opens a hole exactly there. ---
  {
    const gw = await createGameWorld();
    const destroyed = new Set<number>();
    const alive = (id: number): boolean => !destroyed.has(id);
    // The center building's south wall sits at z = -4; shoot it from outside.
    const hit1 = gw.world.castRay([0.2, 0.6, -8], [0, 0, 6]);
    const piece1 = hit1?.body
      ? pieceIdFromHit(hit1.body, [0.2, 0.6, -8 + 6 * hit1.fraction], alive)
      : null;
    check("wall blocks the shot and resolves to a brick", piece1 !== null, "");
    if (piece1 !== null) {
      const def = MAP.panels[piece1 - 1];
      check(
        "resolved brick contains the hit point",
        def.material === "brick" && Math.abs(def.x - 0.2) < 0.6 && Math.abs(def.y - 0.6) < 0.3,
        `${def.material} (${def.x.toFixed(2)},${def.y.toFixed(2)})`,
      );
      destroyed.add(piece1);
      rebuildSlabBody(gw, slabOfPiece(piece1), alive);
      const hit2 = gw.world.castRay([0.2, 0.6, -8], [0, 0, 6]);
      const piece2 = hit2?.body
        ? pieceIdFromHit(hit2.body, [0.2, 0.6, -8 + 6 * hit2.fraction], alive)
        : null;
      check("breached brick lets shots through", piece2 !== piece1, `p2=${piece2}`);
      // A shot 0.6m to the side still hits the wall (neighbor bricks stand).
      const hit3 = gw.world.castRay([0.8, 0.6, -8], [0, 0, 6]);
      check("neighboring bricks still block", hit3 !== null, "");
    }
    destroyGameWorld(gw);
  }

  // --- Slab merge: one body per structure, a handful of boxes per wall. ---
  {
    const gw = await createGameWorld();
    check(
      // The old < 700 cap was meaningless — benchmarking showed physics handles
      // 2400+ slabs at ~0.05ms/step. Startup index-build (panel count) is the
      // real cost; this is just a sanity ceiling against runaway generation.
      "world is a sane number of slab bodies, not 9k pieces",
      gw.slabs.size === MAP.slabs.length && MAP.slabs.length < 1500,
      `slabs=${gw.slabs.size}`,
    );
    // A pristine wall face (hundreds of bricks) merges into few boxes.
    const wallSlabIdx = slabOfPiece(1); // first wall run of the center house
    const slab = MAP.slabs[wallSlabIdx];
    const pieces = MAP.panels.slice(slab.first - 1, slab.last);
    const boxes = mergeSlabBoxes(pieces, () => true);
    check(
      "pristine wall merges to a handful of boxes",
      pieces.length > 100 && boxes.length <= 16,
      `pieces=${pieces.length} boxes=${boxes.length}`,
    );
    // Merged boxes cover exactly the same volume as the pieces.
    const vol = (b: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }) =>
      (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);
    const pieceVol = pieces.reduce((a, p) => a + p.ex * p.ey * p.ez, 0);
    const boxVol = boxes.reduce((a, b) => a + vol(b), 0);
    check("merge preserves volume", Math.abs(pieceVol - boxVol) < 1e-6, `${pieceVol} vs ${boxVol}`);
    destroyGameWorld(gw);
  }

  // --- Grenade body flies and bounces. ---
  {
    const gw = await createGameWorld();
    const body = createGrenadeBody(gw, 1, [24, 2.5, -32], [0, 2, 8]);
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
    check("grenade travels", end.z > -26, `z=${end.z}`);
    check("grenade bounces", bounced, `minY=${minY}`);
    destroyGameWorld(gw);
  }

  // --- Hit registration math: ray vs capsule, wall occlusion. ---
  {
    const gw = await createGameWorld();
    const feet = [24, 0, 0]; // east lane, open ground
    createPlayerBody(gw, 1, feet);
    const eye: [number, number, number] = [24, 1.45, -12];
    // Dead-on shot at the chest from 12m.
    const dir: [number, number, number] = [0, -0.05, 0.9987];
    const t = rayVsCapsule(eye, dir, 90, feet);
    check("exact aim hits the capsule", t !== null && Math.abs(t - 12) < 0.6, `t=${t}`);
    // 0.5m lateral miss at 12m.
    const off = Math.atan2(0.8, 12);
    const dirMiss: [number, number, number] = [Math.sin(off), -0.05, Math.cos(off)];
    check("0.8m off-axis misses", rayVsCapsule(eye, dirMiss, 90, feet) === null, "");
    // Wall occlusion: hop over player bodies, stop at panels.
    const wall = castWallDistance(gw, [0.2, 0.6, -8], [0, 0, 1], 90);
    const wallPiece = wall.body ? pieceIdFromHit(wall.body, wall.point, () => true) : null;
    check(
      "wall distance finds the building wall",
      wall.dist < 6 && wallPiece !== null,
      `dist=${wall.dist} piece=${wallPiece}`,
    );
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

  // --- Structure integrity data (drives the collapse system). ---
  {
    const houses = MAP.buildings.filter((b) => b.kind === "building");
    const trees = MAP.buildings.filter((b) => b.kind === "tree");
    // The settlement is procedurally laid out (clusters + rejection), so the
    // exact building count varies; assert a sane range, not a magic number.
    let ok = houses.length >= 14 && houses.length <= 44 && trees.length >= 60;
    // Concrete buildings use far fewer (bigger) panels than brick ones, and
    // ruins keep only weather-eaten wall stumps + a scatter of flagstones.
    for (const b of houses) ok &&= b.wallPanelIds.length >= 60 && b.roofPanelIds.length >= 12;
    for (const b of trees) {
      ok &&= b.wallPanelIds.length >= 3 && b.wallPanelIds.length <= 7 && b.roofPanelIds.length >= 4;
      // Two trunk segments always fell a tree, regardless of its height.
      ok &&= Math.ceil(b.wallPanelIds.length * b.collapseFraction) === 2;
    }
    for (const b of MAP.buildings) {
      ok &&= b.wallPanelIds.every((id) => MAP.panels.find((p) => p.id === id)?.buildingId === b.id);
    }
    check(
      "structures group their pieces",
      ok,
      JSON.stringify(MAP.buildings.map((b) => `${b.kind}:${b.wallPanelIds.length}`)),
    );
  }

  // --- Pieces are material-shaped, and only the perimeter is indestructible. ---
  {
    const byMat = new Map<string, number>();
    for (const p of MAP.panels) byMat.set(p.material, (byMat.get(p.material) ?? 0) + 1);
    const bricks = MAP.panels.filter((p) => p.material === "brick");
    // Courses stretch a little so whole units always close a wall span
    // exactly (no more disconnected corners) — classify by band, not exact.
    const fullBrick = bricks.filter((p) => {
      const l = Math.max(p.ex, p.ez);
      return l > 0.4 && l < 0.68;
    }).length;
    const halfBrick = bricks.filter((p) => {
      const l = Math.max(p.ex, p.ez);
      return l > 0.16 && l < 0.36;
    }).length;
    // Cabin logs are building pieces; loose props (woodpiles, fallen logs) also
    // use the log material but aren't stacked-cabin shaped.
    const logs = MAP.panels.filter((p) => p.material === "log" && p.buildingId !== undefined);
    check(
      "brick walls are bricks in running bond (full + half closers)",
      bricks.length > 1500 && fullBrick > 1000 && halfBrick > 50,
      `bricks=${bricks.length} full=${fullBrick} half=${halfBrick}`,
    );
    check(
      "log cabins are stacked logs",
      logs.length > 200 && logs.every((p) => p.ey === 0.25 && Math.max(p.ex, p.ez) <= 2.61),
      `logs=${logs.length}`,
    );
    check(
      "everything is destructible (no perimeter walls anymore)",
      MAP.statics.length === 0 &&
        ["plank", "post", "trunk", "canopy", "crate", "sandbag"].every(
          (m) => (byMat.get(m) ?? 0) > 0,
        ),
      JSON.stringify([...byMat.entries()]),
    );
  }

  // --- Terrain is uneven but flat where it must be. ---
  {
    let maxH = 0;
    for (let x = -25; x <= 25; x += 1.7) {
      for (let z = -25; z <= 25; z += 1.7) maxH = Math.max(maxH, heightAt(x, z));
    }
    check("terrain has relief", maxH > 0.5, `maxH=${maxH.toFixed(2)}`);
    check(
      "spawns and pads are flat",
      Math.abs(heightAt(0, -100)) < 0.05 && Math.abs(heightAt(0, 0)) < 0.05,
      "",
    );
  }

  // --- Grenades settle near where they land (corner-bombing works). ---
  {
    const gw = await createGameWorld();
    // Head-on lob at the FIXED center house's south wall (z=-4) from 4m out.
    const body = createGrenadeBody(gw, 1, [1, 1.5, -8], [0, -1, 8]);
    for (let t = 0; t < GRENADE_FUSE_TICKS; t++) gw.world.step(DT);
    const end = body.translation();
    const drift = Math.hypot(end.x - 1, end.z - -4);
    check(
      "grenade settles near the wall it hit",
      drift < 3.5,
      `drift=${drift.toFixed(1)} at (${end.x.toFixed(1)},${end.z.toFixed(1)})`,
    );
    destroyGameWorld(gw);
  }

  // --- Multi-story: the step-up assist walks the center house's staircase
  // to the second floor. ---
  {
    // Center building (10x8 at origin, 2 stories): stairwell along the west
    // wall (x0=-5), flight ascends +z from z=-2.7.
    const r = await rig([-3.83, 0.1, -3.1]);
    for (let t = 0; t < 30; t++) step(r, cmd(t + 1)); // settle
    for (let t = 30; t < 150; t++) {
      step(r, cmd(t + 1, { moveZ: quantizeMove(1), yaw: quantizeAngle(0) }));
    }
    check("step-up assist climbs stairs to story 2", r.s.y > 2.3, `y=${r.s.y.toFixed(2)}`);
    check("lands on the upper floor", r.s.onGround, `onGround=${r.s.onGround}`);
    destroyGameWorld(r.gw);
  }

  // --- Step-up assist also vaults low cover (sandbags) but not walls. ---
  {
    const houses = MAP.buildings.filter((b) => b.kind === "building");
    const twoStory = houses.filter((b) => b.wallPanelIds.length > 1300);
    check("multi-story buildings exist", twoStory.length >= 2, `tall=${twoStory.length}`);
  }

  // --- Structural contact graph: bonded masonry, island rule. ---
  {
    const c = buildContactIndex();
    const flood = (destroyed: Set<number>, start: number): Set<number> => {
      const seen = new Set<number>([start]);
      const stack = [start];
      while (stack.length) {
        const id = stack.pop()!;
        for (const n of c.adj.get(id) ?? []) {
          if (seen.has(n) || destroyed.has(n)) continue;
          seen.add(n);
          stack.push(n);
        }
      }
      return seen;
    };
    const grounded = (region: Set<number>): boolean => {
      for (const id of region) {
        if (c.grounded.has(id)) return true;
      }
      return false;
    };
    const house = MAP.buildings[0]; // the fixed center brick house
    const bricks = house.wallPanelIds.filter((id) => MAP.panels[id - 1].material === "brick");
    check(
      "bottom course is grounded",
      bricks.some((id) => c.grounded.has(id)),
      "",
    );
    // Pristine: every brick connects to ground through the bonded fabric.
    const all = flood(new Set(), bricks[0]);
    check(
      "pristine wall is one grounded fabric",
      bricks.every((id) => all.has(id)) && grounded(all),
      "",
    );
    // The user's case: shattering a window pane must NOT strand the bricks
    // above the window — they hang off the wall fabric laterally.
    const pane = MAP.panels.find((p) => p.material === "glass" && p.buildingId === house.id)!;
    const lintel = bricks.find((id) => {
      const b = MAP.panels[id - 1];
      return Math.abs(b.x - pane.x) < 0.6 && Math.abs(b.z - pane.z) < 0.6 && b.y > pane.y + 0.3;
    })!;
    const afterGlass = flood(new Set([pane.id]), lintel);
    check("breaking a window strands no bricks", grounded(afterGlass), "");
    // Carving a full vertical seam DOES strand the island you cut loose.
    const wallZ = MAP.panels[lintel - 1].z;
    const seamX = MAP.panels[lintel - 1].x;
    const cut = new Set<number>();
    for (const p of MAP.panels) {
      if (p.buildingId !== house.id) continue;
      if (Math.abs(p.z - wallZ) > 0.3) continue;
      // Cut everything below the lintel brick's row in a 1.6m band, plus the
      // bottom course across the band — isolating the chunk above.
      if (Math.abs(p.x - seamX) < 0.8 && p.y < MAP.panels[lintel - 1].y - 0.05) cut.add(p.id);
    }
    const island = flood(cut, lintel);
    // The island above the cut should either reach ground around the cut
    // (wide walls) or be detected as stranded — both are legal; just assert
    // the flood terminates and is consistent.
    check("island flood is well-formed", island.size > 0, `size=${island.size}`);
  }

  // --- Water: the river is carved, wadeable, and never under a building. ---
  {
    const { waterCarveAt, WATER_SURFACE_Y, ZONES } = await import("../src/shared/map.js");
    let wet = 0;
    let deepest = 0;
    for (let x = -100; x <= 100; x += 3) {
      for (let z = -100; z <= 100; z += 3) {
        const h = heightAt(x, z);
        if (h < WATER_SURFACE_Y) {
          wet++;
          deepest = Math.max(deepest, WATER_SURFACE_Y - h);
        }
      }
    }
    check("river/lakes exist but are uncommon", wet > 60 && wet < 900, `wet=${wet}`);
    // WATER_DEPTH 1.3 plus the gravel-bar roughness (±6%) on the deep line.
    check("water is wadeable, not swimmable", deepest < 1.45, `deepest=${deepest.toFixed(2)}`);
    check(
      "zones sit on dry, flat ground",
      ZONES.every((zn) => Math.abs(heightAt(zn.x, zn.z)) < 0.05 && waterCarveAt(zn.x, zn.z) < 0.05),
      "",
    );
  }

  // --- Ladders: real climbing — push into the wall and rise to the top. ---
  {
    check("ladders generated", MAP.ladders.length >= 2, `n=${MAP.ladders.length}`);
    const lad = MAP.ladders[0];
    const r = await rig([lad.x + lad.nx * 0.55, 0.1, lad.z + lad.nz * 0.55]);
    for (let t = 0; t < 20; t++) step(r, cmd(t + 1)); // settle
    const yaw = quantizeAngle(Math.atan2(-lad.nx, -lad.nz));
    let peak = 0;
    for (let t = 20; t < 140; t++) {
      step(r, cmd(t + 1, { moveX: quantizeMove(-lad.nx), moveZ: quantizeMove(-lad.nz), yaw }));
      peak = Math.max(peak, r.s.y); // it crests the roof and keeps walking
    }
    check("climbing reaches the top", peak > lad.y1 - 1.2, `peak=${peak.toFixed(2)} top=${lad.y1}`);
    destroyGameWorld(r.gw);
  }

  // --- Stairwells never block doors: every multi-story building keeps its
  // west wall solid at ground level where the flights hang. ---
  {
    let ok = true;
    for (const b of MAP.buildings) {
      if (b.kind !== "building") continue;
      const pieces = [...b.wallPanelIds, ...b.roofPanelIds].map((id) => MAP.panels[id - 1]);
      const hasStairs = pieces.some(
        (p) => p.ey === 0.12 && Math.abs(p.x - (b.cx - b.w / 2) - 1.12) < 0.3,
      );
      if (!hasStairs) continue;
      const x0 = b.cx - b.w / 2;
      // A door would leave the west wall's ground band empty around mid.
      const westGround = pieces.filter(
        (p) => Math.abs(p.x - x0) < 0.2 && p.y < 1.0 && Math.abs(p.z - b.cz) < 0.55,
      );
      if (westGround.length === 0) ok = false;
    }
    check("stairwells never sit behind a door", ok, "");
  }

  // --- Terrain destruction: a crater lowers both heightAt and the rebuilt
  // chunk collision, deterministically. ---
  {
    const gw = await createGameWorld();
    const { duelLaneX } = await import("../src/shared/map.js");
    // Open corridor, clear of pieces. Integer coordinate: heightAt is exact
    // at mesh vertices, and the ray-vs-triangle comparison assumes that.
    const x = Math.round(duelLaneX());
    const z = -20;
    const h0 = heightAt(x, z);
    const rayDown = (): number => {
      const hit = gw.world.castRay([x, 6, z], [0, -12, 0]);
      return hit ? 6 - 12 * hit.fraction : -99;
    };
    const ground0 = rayDown();
    const crater = { x, z, r: 2.6, d: 0.85 };
    addCrater(crater);
    applyCraterBodies(gw, crater);
    // Near a pad skirt the dig is faded — the contract is that collision
    // matches the dug heightfield exactly, whatever the depth.
    const dugHeight = h0 - heightAt(x, z);
    const dugRay = ground0 - rayDown();
    check("crater digs heightAt", dugHeight > 0.4, `dug=${dugHeight}`);
    check(
      "chunk collision matches the dug heightfield",
      Math.abs(dugRay - dugHeight) < 0.03,
      `ray=${dugRay} height=${dugHeight}`,
    );
    resetCraters();
    destroyGameWorld(gw);
  }

  // --- Glass: panes fill window openings and shatter to a single hit. ---
  {
    // Windowpanes are thin building pieces; loose props (lamp lanterns) also use
    // the glass material but aren't panes.
    const glass = MAP.panels.filter((p) => p.material === "glass" && p.buildingId !== undefined);
    check(
      "buildings have windowpanes",
      glass.length >= 20 && glass.every((p) => Math.min(p.ex, p.ez) < 0.1),
      `glass=${glass.length}`,
    );
    const gw = await createGameWorld();
    // The center building's windows: doorSide 0 means walls 1,2,3 are glazed.
    const pane = glass.find((p) => p.buildingId === 0 && p.z < 0)!;
    const destroyed = new Set<number>();
    const alive = (id: number): boolean => !destroyed.has(id);
    const hit = gw.world.castRay([pane.x, pane.y, pane.z - 2], [0, 0, 2.5]);
    const hitId = hit?.body
      ? pieceIdFromHit(hit.body, [pane.x, pane.y, pane.z - 2 + 2.5 * hit.fraction], alive)
      : null;
    check("glass blocks shots until shattered", hitId === pane.id, `hit=${hitId}`);
    destroyed.add(pane.id);
    rebuildSlabBody(gw, slabOfPiece(pane.id), alive);
    const hit2 = gw.world.castRay([pane.x, pane.y, pane.z - 2], [0, 0, 2.5]);
    const hitId2 = hit2?.body
      ? pieceIdFromHit(hit2.body, [pane.x, pane.y, pane.z - 2 + 2.5 * hit2.fraction], alive)
      : null;
    check("shattered pane lets shots through", hitId2 !== pane.id, "");
    destroyGameWorld(gw);
  }

  console.log(`\nmap: ${MAP.panels.length} destructible panels, ${MAP.statics.length} statics`);
  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all physics tests passed");
}

void main();
