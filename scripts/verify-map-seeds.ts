import { performance } from "node:perf_hooks";
import { CURATED_MAP_SEEDS, initMap, validateCuratedSpawnCover } from "../src/shared/map.js";

const startedAt = performance.now();
for (const seed of CURATED_MAP_SEEDS) {
  initMap(seed);
  const validationStartedAt = performance.now();
  const valid = validateCuratedSpawnCover();
  console.log(
    `[map-seeds] seed=${seed} valid=${valid} time=${(performance.now() - validationStartedAt).toFixed(0)}ms`,
  );
  if (!valid) throw new Error(`curated seed ${seed} still needs runtime spawn-cover repairs`);
}
console.log(`[map-seeds] total=${(performance.now() - startedAt).toFixed(0)}ms`);
