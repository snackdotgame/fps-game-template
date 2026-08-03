// Behaviour tests for structural collapse: buildings must physically come
// down (not blink out), the chunks they come down in must stay bounded, and
// falling masonry must crush what is under it without gassing bystanders.
import { CURATED_MAP_SEEDS, heightAt, initMap, MAP } from "../src/shared/map.js";
import { GameSim } from "../src/shared/sim.js";
import { writeChar } from "../src/shared/physics.js";

const MAX_CHUNK_PIECES = 28; // mirrors sim.ts
let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

initMap(CURATED_MAP_SEEDS[0]);
// A building with real posts under it, if the map has one; otherwise the
// biggest structure on the map.
const withPosts = MAP.buildings.filter(
  (b) =>
    b.kind === "building" &&
    b.wallPanelIds.filter((id) => MAP.panels[id - 1]?.material === "post").length >= 3,
);
const target =
  withPosts[0] ??
  [...MAP.buildings]
    .filter((b) => b.kind === "building")
    .sort((a, b) => b.wallPanelIds.length - a.wallPanelIds.length)[0];
console.log(
  `target building ${target.id}: ${target.wallPanelIds.length} wall pieces, ` +
    `${target.wallPanelIds.filter((id) => MAP.panels[id - 1]?.material === "post").length} posts`,
);

const sim = new GameSim(7);
await sim.init();
// stepWorld() deliberately does not advance the tick (the server owns that),
// so the harness drives it — otherwise anything gated on tick never expires.
const step = (): void => {
  sim.tick++;
  sim.stepWorld();
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = sim as any;

// --- Collapse ---------------------------------------------------------------
const posts = target.wallPanelIds.filter((id) => MAP.panels[id - 1]?.material === "post");
if (posts.length >= 3) {
  // Cut the legs only — every wall stays untouched.
  for (const id of posts.slice(0, Math.ceil(posts.length * 0.6))) priv.destroyPanel(id);
  check(
    sim.collapsedBuildings.has(target.id),
    "cutting 60% of the posts fells the building",
    `posts=${posts.length}, collapsed=${sim.collapsedBuildings.has(target.id)}`,
  );
} else {
  for (const id of target.wallPanelIds.slice(0, Math.ceil(target.wallPanelIds.length * 0.6))) {
    priv.destroyPanel(id);
  }
  check(sim.collapsedBuildings.has(target.id), "wall damage fells the building");
}

// The structure must physically fall, not vanish.
let sawFalling = 0;
let biggestChunk = 0;
for (let t = 0; t < 240; t++) {
  step();
  sawFalling = Math.max(sawFalling, sim.falling.size);
  for (const f of sim.falling.values()) biggestChunk = Math.max(biggestChunk, f.pieces.length);
}
check(sawFalling > 0, "collapse releases tumbling chunks", `peak concurrent chunks=${sawFalling}`);
check(
  biggestChunk <= MAX_CHUNK_PIECES,
  "no chunk exceeds the size cap",
  `biggest=${biggestChunk} cap=${MAX_CHUNK_PIECES}`,
);
console.log(`collapse: peak ${sawFalling} chunks, biggest ${biggestChunk} pieces`);

// --- Crush ------------------------------------------------------------------
const victim = sim.addPlayer(0, 0, 0);
// Step clear of spawn protection first, or every check below passes vacuously.
while (sim.tick < victim.protectUntilTick + 2) step();

// Debris that has come to rest must not damage anyone standing in it.
const restingHp = victim.hp;
for (let t = 0; t < 90; t++) step();
check(
  victim.hp === restingHp,
  "settled rubble does not damage a bystander",
  `hp ${restingHp} -> ${victim.hp}`,
);

// ...but a building coming down on your head does. Stand the victim inside a
// second structure and cut it down on top of them.
const second = [...MAP.buildings]
  .filter((b) => b.kind === "building" && !sim.collapsedBuildings.has(b.id))
  .sort((a, b) => b.wallPanelIds.length - a.wallPanelIds.length)[0];
victim.state.x = second.cx;
victim.state.z = second.cz;
victim.state.y = heightAt(second.cx, second.cz) + 0.1;
victim.state.vx = 0;
victim.state.vy = 0;
victim.state.vz = 0;
writeChar(victim.body, victim.state);
const crushHpBefore = victim.hp;
for (const id of second.wallPanelIds.slice(0, Math.ceil(second.wallPanelIds.length * 0.62))) {
  priv.destroyPanel(id);
}
check(sim.collapsedBuildings.has(second.id), "second building collapses");
let crushed = false;
for (let t = 0; t < 300 && !crushed; t++) {
  step();
  if (victim.hp < crushHpBefore || victim.dead) crushed = true;
}
check(
  crushed,
  "a building coming down crushes whoever is under it",
  `hp ${crushHpBefore} -> ${victim.hp}, dead=${victim.dead}`,
);
console.log(`crush: hp ${crushHpBefore} -> ${victim.hp}${victim.dead ? " (killed)" : ""}`);

// --- Persistent debris stays bounded ----------------------------------------
// Every settled piece is a permanent static body on the server and an instanced
// slot on the client. Levelling a village must not walk that count up forever.
const BUILT_PANEL_CAP = 2400; // mirrors sim.ts
const more = MAP.buildings
  .filter((b) => b.kind === "building" && !sim.collapsedBuildings.has(b.id))
  .slice(0, 8);
for (const b of more) {
  for (const id of b.wallPanelIds.slice(0, Math.ceil(b.wallPanelIds.length * 0.62))) {
    priv.destroyPanel(id);
  }
  for (let t = 0; t < 300; t++) step();
}
check(
  priv.builtPanels.size <= BUILT_PANEL_CAP,
  "persistent runtime pieces stay under the cap",
  `builtPanels=${priv.builtPanels.size} cap=${BUILT_PANEL_CAP}`,
);
console.log(`after ${more.length} more collapses: builtPanels=${priv.builtPanels.size}`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall collapse checks passed");
