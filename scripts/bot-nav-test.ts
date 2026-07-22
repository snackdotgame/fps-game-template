// Deterministic connectivity checks for the authoritative bot navigation grid.
// Every curated map must route both teams from their spawn spread to every
// conquest zone, and collision-topology changes must invalidate cached paths.

import {
  BUILT_PANEL_ID_BASE,
  CURATED_MAP_SEEDS,
  heightAt,
  initMap,
  spawnPoint,
  ZONES,
} from "../src/shared/map.js";
import { destroyGameWorld } from "../src/shared/physics.js";
import { BotNav, initBotNav } from "../src/server/botNav.js";
import { GameSim } from "../src/shared/sim.js";

await initBotNav();
let routes = 0;
for (let seedIdx = 0; seedIdx < CURATED_MAP_SEEDS.length; seedIdx++) {
  const seed = CURATED_MAP_SEEDS[seedIdx];
  initMap(seed);
  const sim = new GameSim(0xbeac4);
  await sim.init();
  const nav = new BotNav();
  nav.warm(sim);
  const initialVersion = nav.sync(sim);
  const initialRouteVersion = nav.routeVersion;

  // Runtime cover must immediately divert short-horizon steering, then stop
  // affecting it as soon as that cover is removed.
  const steerStart = spawnPoint(0, 0);
  const coverX = steerStart[0] + 3;
  const coverZ = steerStart[2];
  const cover = {
    id: BUILT_PANEL_ID_BASE,
    x: coverX,
    y: heightAt(coverX, coverZ) + 1.5,
    z: coverZ,
    ex: 0.2,
    ey: 3,
    ez: 4,
    material: "metal" as const,
  };
  sim.builtPanels.set(cover.id, cover);
  sim.navRevision++;
  const builtVersion = nav.sync(sim);
  const diverted = nav.steer(sim, steerStart, 1, 0, 1);
  if (builtVersion !== initialVersion + 1 || Math.abs(diverted.z) < 0.1) {
    throw new Error(`bot nav did not avoid built cover: seed=${seed}`);
  }
  if (nav.routeVersion !== initialRouteVersion) {
    throw new Error(`bot nav invalidated all cached routes for built cover: seed=${seed}`);
  }
  sim.builtPanels.delete(cover.id);
  sim.navRevision++;
  const removedVersion = nav.sync(sim);
  const direct = nav.steer(sim, steerStart, 1, 0, 1);
  if (removedVersion !== builtVersion + 1 || Math.abs(direct.z) > 0.01) {
    throw new Error(`bot nav retained removed cover: seed=${seed}`);
  }
  if (nav.routeVersion !== initialRouteVersion) {
    throw new Error(`bot nav invalidated all cached routes for removed cover: seed=${seed}`);
  }

  for (let team = 0; team < 2; team++) {
    for (let slot = team; slot < 12; slot += 2) {
      const start = spawnPoint(team, slot);
      for (const zone of ZONES) {
        const route = nav.findRoute(sim, start, [zone.x, 0, zone.z]);
        if (!route || route.length === 0) {
          throw new Error(
            `bot nav disconnected: seed=${seed} team=${team} slot=${slot} zone=${zone.letter}`,
          );
        }
        routes++;
      }
    }
  }

  // The real sim increments navRevision whenever cover/walls are added or
  // removed. Verify the nav layer consumes that revision exactly once.
  sim.navRevision++;
  const changedVersion = nav.sync(sim);
  if (changedVersion !== removedVersion + 1 || nav.sync(sim) !== changedVersion) {
    throw new Error(`bot nav revision did not settle: seed=${seed}`);
  }

  // New rounds regenerate MAP in place while retaining the BotNav instance.
  // The cached grid must rebuild for the new seed rather than following the
  // previous round's terrain and buildings.
  const nextSeed = CURATED_MAP_SEEDS[(seedIdx + 1) % CURATED_MAP_SEEDS.length];
  initMap(nextSeed);
  const regeneratedVersion = nav.sync(sim);
  const regeneratedRouteVersion = nav.routeVersion;
  if (
    regeneratedVersion !== changedVersion + 1 ||
    regeneratedRouteVersion !== initialRouteVersion + 1 ||
    !nav.findRoute(sim, spawnPoint(0, 0), [ZONES[2].x, 0, ZONES[2].z])
  ) {
    throw new Error(`bot nav did not rebuild for map seed: seed=${seed} next=${nextSeed}`);
  }
  sim.navGeneration++;
  sim.navRevision++;
  const resetVersion = nav.sync(sim);
  if (resetVersion !== regeneratedVersion + 1 || nav.routeVersion !== regeneratedRouteVersion + 1) {
    throw new Error(`bot nav did not rebuild for round reset: seed=${seed}`);
  }
  destroyGameWorld(sim.gw);
  console.log(`[bot-nav] seed=${seed} routes=${routes} version=${resetVersion}`);
}

console.log(`[bot-nav] PASS routes=${routes} seeds=${CURATED_MAP_SEEDS.length}`);
