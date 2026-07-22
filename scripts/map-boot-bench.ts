import { performance } from "node:perf_hooks";
import { CURATED_MAP_SEEDS, initMap, MAP } from "../src/shared/map.js";

const seeds = [...CURATED_MAP_SEEDS];
let total = 0;
let worst = 0;
for (const seed of seeds) {
  const startedAt = performance.now();
  initMap(seed);
  const elapsed = performance.now() - startedAt;
  total += elapsed;
  worst = Math.max(worst, elapsed);
  console.log(
    `[map-bench] seed=${seed >>> 0} time=${elapsed.toFixed(1)}ms panels=${MAP.panels.length} slabs=${MAP.slabs.length}`,
  );
}
console.log(`[map-bench] avg=${(total / seeds.length).toFixed(1)}ms worst=${worst.toFixed(1)}ms`);
