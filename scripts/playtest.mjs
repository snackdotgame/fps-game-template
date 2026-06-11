// End-to-end playtest: two browser clients fight on the destructible map.
// Verifies connection, teams, movement sync, shooting a wall to destruction
// (propagated to both clients), grenade demolition, building cover, a real
// kill via aimed rifle fire, respawn, and leave handling.
//
// With the dev server running:
//   PLAYWRIGHT_RESOLVE_FROM=/path/to/some/package.json node scripts/playtest.mjs
// HOST defaults to http://127.0.0.1:3030/ — override with BP_HOST / BP_CLIENT_PORT.
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_RESOLVE_FROM);
const { chromium } = require("playwright");

const HOST = process.env.BP_HOST ?? "http://127.0.0.1:3030/";
const CLIENT_PORT = process.env.BP_CLIENT_PORT ?? "3031";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
}

const browser = await chromium.launch();

async function openClient(label) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 900, height: 600 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, String(e).slice(0, 300)));
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  let frame;
  for (let i = 0; i < 120 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes(`:${CLIENT_PORT}`));
    if (!frame) await page.waitForTimeout(250);
  }
  if (!frame) throw new Error(`${label}: client frame never appeared`);
  await frame.waitForFunction(
    () => window.__fps && window.__fps.connectionState() === "connected",
    null,
    { timeout: 40000, polling: 100 },
  );
  const fps = (fn, ...args) => frame.evaluate(([f, a]) => window.__fps[f](...a), [fn, args]);
  return { page, frame, fps, label };
}

// Walk a client toward a target point using world-space move intents.
async function goTo(c, tx, tz, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const [x, , z] = await c.fps("playerPosition");
    const dx = tx - x;
    const dz = tz - z;
    if (Math.hypot(dx, dz) < 1.2) {
      await c.fps("stopDrive");
      return true;
    }
    const len = Math.hypot(dx, dz) || 1;
    await c.fps("drive", { moveX: dx / len, moveZ: dz / len, sprint: true, jump: false }, 12);
    await c.page.waitForTimeout(320);
  }
  await c.fps("stopDrive");
  return false;
}

console.log("connecting two clients…");
const a = await openClient("A");
const b = await openClient("B");
await a.page.waitForTimeout(1500);

// --- Roster + teams. ---
const rosterA = await a.fps("roster");
check("both see 2+ players", rosterA.length >= 2, JSON.stringify(rosterA));
const teams = new Set(rosterA.map((p) => p.team));
check("players split across teams", teams.size === 2, JSON.stringify([...teams]));

// --- Movement + cross-client sync. ---
const aStart = await a.fps("playerPosition");
await a.fps("drive", { moveX: 1, moveZ: 0, sprint: true }, 45);
await a.page.waitForTimeout(2200);
const aPos = await a.fps("playerPosition");
check("A moved", Math.hypot(aPos[0] - aStart[0], aPos[2] - aStart[2]) > 3, JSON.stringify(aPos));

// --- Destruction: A shoots the nearest cover wall until a panel dies. ---
// A team-0 spawn is near (0, -23); the south cover wall spans x 2..10 at z=-10.
const destroyed0 = await a.fps("destroyedCount");
await goTo(a, 6, -16);
{
  const [x, y, z] = await a.fps("playerPosition");
  const yaw = Math.atan2(6 - x, -10 - z);
  const pitch = Math.atan2(0.6 - (y + 1.45), Math.hypot(6 - x, -10 - z));
  await a.fps("look", yaw, pitch);
}
for (let i = 0; i < 14 && (await a.fps("destroyedCount")) === destroyed0; i++) {
  await a.fps("drive", { fire: true }, 10); // keep current look
  await a.page.waitForTimeout(350);
  if ((await a.fps("ammo")) < 3) {
    await a.fps("drive", { reload: true }, 4);
    await a.page.waitForTimeout(2200);
  }
}
const destroyedA = await a.fps("destroyedCount");
check("gunfire destroys a panel", destroyedA > destroyed0, `destroyed=${destroyedA}`);
await a.page.waitForTimeout(800);
const destroyedB = await b.fps("destroyedCount");
check("destruction propagates to B", destroyedB === destroyedA, `B=${destroyedB} A=${destroyedA}`);

// --- Grenade demolition: chuck one at the wall's base so it detonates there. ---
{
  const [x, , z] = await a.fps("playerPosition");
  await a.fps("look", Math.atan2(6 - x, -10 - z), -0.08);
}
await a.fps("drive", { grenade: true }, 3);
await a.page.waitForTimeout(3500); // fuse + destruction broadcast
const destroyedAfterNade = await a.fps("destroyedCount");
check(
  "grenade demolishes panels",
  destroyedAfterNade > destroyedA,
  `destroyed=${destroyedAfterNade}`,
);

// --- Building: deploy cover, both clients gain a panel. ---
const panels0 = await a.fps("panelCount");
await a.fps("look", Math.PI, 0); // face back toward open ground
await a.page.waitForTimeout(200);
await a.fps("drive", { build: true }, 3);
await a.page.waitForTimeout(900);
const panelsA = await a.fps("panelCount");
check("built cover appears for A", panelsA === panels0 + 1, `A ${panels0} -> ${panelsA}`);
const panelsB = await b.fps("panelCount");
check("built cover appears for B", panelsB === panelsA, `B=${panelsB} A=${panelsA}`);

// --- Combat: both walk to an open lane, A aims at B and fires to a kill. ---
console.log("staging a duel on the east lane…");
// Waypoint around the east-side buildings, then up the lane.
await goTo(a, 24, -22);
const okA = await goTo(a, 24, -14);
await goTo(b, 24, 22);
const okB = await goTo(b, 24, 14);
check("both reached the duel lane", okA && okB, `A=${okA} B=${okB}`);
const scores0 = await a.fps("scores");
let killed = false;
for (let round = 0; round < 10 && !killed; round++) {
  const [ax, ay, az] = await a.fps("playerPosition");
  const [bx, by, bz] = await b.fps("playerPosition");
  const yaw = Math.atan2(bx - ax, bz - az);
  const dist = Math.hypot(bx - ax, bz - az);
  const pitch = Math.atan2(by + 1.0 - (ay + 1.45), dist);
  await a.fps("look", yaw, pitch);
  await a.fps("drive", { fire: true }, 14);
  await a.page.waitForTimeout(550);
  if ((await a.fps("ammo")) < 4) {
    await a.fps("drive", { reload: true }, 4);
    await a.page.waitForTimeout(2200);
  }
  killed = (await b.fps("hp")) <= 0 || ((await b.fps("selfStatus")) & 1) !== 0;
}
check("A killed B with aimed fire", killed, `B hp=${await b.fps("hp")}`);
await a.page.waitForTimeout(600);
const scores1 = await a.fps("scores");
check(
  "team score increased",
  scores1[0] + scores1[1] > scores0[0] + scores0[1],
  JSON.stringify(scores1),
);

// --- Respawn: B comes back with full HP. ---
await b.page.waitForTimeout(3800);
const bHp = await b.fps("hp");
const bStatus = await b.fps("selfStatus");
check(
  "B respawned with full hp",
  bHp === 100 && (bStatus & 1) === 0,
  `hp=${bHp} status=${bStatus}`,
);

await a.page.screenshot({ path: "/tmp/bp-play-a.png" });
await b.page.screenshot({ path: "/tmp/bp-play-b.png" });

// --- Leave. ---
const rosterBefore = await a.fps("roster");
await b.page.context().close();
let rosterAfter = rosterBefore;
for (let i = 0; i < 45 && rosterAfter.length >= rosterBefore.length; i++) {
  await a.page.waitForTimeout(1000);
  rosterAfter = await a.fps("roster");
}
check(
  "leave removes player",
  rosterAfter.length === rosterBefore.length - 1,
  JSON.stringify(rosterAfter),
);

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nplaytest passed");
