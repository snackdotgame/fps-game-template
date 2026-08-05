// Pick the runtime seed rotation and bake its spawn-cover repairs.
//
// Runtime maps rotate through CURATED_MAP_SEEDS, and every seed lands on one
// climate (the Whittaker roll in map.ts), so the rotation IS the variety
// players see. This picks one seed per climate and dumps the ray-marched
// repair stamps for each; paste the output into map.ts.
//
// RE-RUN THIS whenever anything moves the terrain heightfield — relief, water,
// hills, or the settlement layout (lot pads flatten ground through shapeFade).
// The baked stamps are ray-marched against one specific heightfield and go
// stale the moment it moves; `npm run test:map-seeds` is the detector.
//
//   npm run curate:map-seeds
//
// Candidates are rejected if they build too heavy (panel count drives client
// load time), if the repair search can't seal every spawn sightline, or if
// they need so many stamps that the map would read as a lumpy mess — reliefAt
// loops over every hill per height sample, so stamp count is a real cost.

import { performance } from "node:perf_hooks";
import {
  CLIMATE_NAMES,
  MAP,
  climate,
  climateName,
  curateSpawnRepairs,
  initMap,
  isIsland,
  validateCuratedSpawnCover,
  villageLotCount,
} from "../src/shared/map.js";

// Client load time scales with this. Raised from 42k when settlement
// archetypes went in: at 42k the search systematically rejected the dense
// archetypes (market town, industrial belt, stronghold) and the rotation
// silently collapsed back to sparse maps. Map build measures 110ms at 50k
// against 99ms at 40k, so the server side is nowhere near the limit.
const PANEL_BUDGET = 50_000;
const REPAIR_BUDGET = 60; // stamps; the historical tables sit around 20
const CANDIDATES = 6000;

interface Pick {
  seed: number;
  panels: number;
  repairs: Array<[number, number, number, number]>;
  ms: number;
}

// One MAINLAND and one ISLAND seed per climate. Landform is the loudest thing
// about a map, so a rotation that is all mainland hides half the generator —
// and the two play completely differently at the same climate. Badlands is
// landlocked (islandP 0), so it contributes mainland only and the search just
// never finds an island for it.
const key = (c: number, island: boolean): number => c * 2 + (island ? 1 : 0);
const picked = new Map<number, Pick>();
const startedAt = performance.now();
let tried = 0;

// A village must land at least this many lots, and at least this share of the
// size its archetype asked for.
const VILLAGE_FLOOR = 6;
const VILLAGE_SHARE = 0.55;

for (let i = 0; i < CANDIDATES; i++) {
  // Any deterministic spread works; this walks a golden-ratio stride so
  // consecutive candidates aren't neighbours in seed space.
  const seed = ((Math.imul(i + 1, 0x9e3779b9) >>> 0) ^ 0x5eed17) >>> 0;
  initMap(seed);
  const c = climate();
  const k = key(c, isIsland());
  if (picked.has(k)) continue;
  if (MAP.panels.length > PANEL_BUDGET) continue;
  // A map has to have a TOWN in it. The village is the only settlement whose
  // size is fixed by the archetype rather than by whatever room the terrain
  // leaves, so a seed that starves it ships as an undifferentiated field of
  // hamlets — which is exactly how these maps used to read. Both bars matter:
  // the floor rejects a village that barely exists, the share rejects one that
  // asked for sixteen buildings and got seven.
  const [vPlaced, vWanted] = villageLotCount();
  if (vPlaced < VILLAGE_FLOOR || vPlaced < vWanted * VILLAGE_SHARE) continue;

  tried++;
  const t0 = performance.now();
  const repairs = curateSpawnRepairs();
  const ms = performance.now() - t0;
  if (repairs.length > REPAIR_BUDGET) continue;
  // Convergence, not just count. curateSpawnRepairs() leaves its stamps in
  // place, so a second pass that adds nothing means the table really does seal
  // the map. A stamp can open a fresh gap as it closes one, and such a seed
  // passes the count budget but fails `npm run test:map-seeds` after pasting.
  if (!validateCuratedSpawnCover()) continue;

  picked.set(k, { seed, panels: MAP.panels.length, repairs, ms });
  console.log(
    `[curate] ${climateName().padEnd(10)} ${(isIsland() ? "island" : "mainland").padEnd(8)} seed=${String(seed).padEnd(11)} panels=${MAP.panels.length} village=${vPlaced}/${vWanted} repairs=${repairs.length} search=${ms.toFixed(0)}ms`,
  );
}

// Every climate must appear at least once; the island variant is a bonus that
// only exists where the climate's islandP allows one.
const missing = CLIMATE_NAMES.filter(
  (_, c) => !picked.has(key(c, false)) && !picked.has(key(c, true)),
);
if (missing.length > 0) {
  throw new Error(`no candidate seed found for: ${missing.join(", ")} (searched ${tried})`);
}

const order = [...picked.entries()].sort((a, b) => a[0] - b[0]);
const label = (k: number): string => `${CLIMATE_NAMES[k >> 1]}${k & 1 ? " (island)" : ""}`;

console.log("\n// --- paste into src/shared/map.ts ---\n");
console.log(
  `export const CURATED_MAP_SEEDS = [\n${order.map(([k, p]) => `  ${p.seed}, // ${label(k)}`).join("\n")}\n] as const;`,
);
console.log("const CURATED_SPAWN_REPAIRS: Readonly<");
console.log("  Record<number, ReadonlyArray<readonly [number, number, number, number]>>");
console.log("> = {");
for (const [k, p] of order) {
  console.log(`  // ${label(k)}`);
  console.log(`  ${p.seed}: [`);
  for (const [x, z, r, a] of p.repairs) {
    console.log(`    [${+x.toFixed(6)}, ${+z.toFixed(6)}, ${+r.toFixed(6)}, ${+a.toFixed(6)}],`);
  }
  console.log("  ],");
}
console.log("};");
console.log(`\n// total ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
console.log("// After pasting, run: npm run test:map-seeds");
