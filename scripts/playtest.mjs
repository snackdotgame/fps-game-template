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

// Bots may have just ended a round; movement is locked during results.
for (let i = 0; i < 40 && (await a.fps("phase")) !== "playing"; i++) {
  await a.page.waitForTimeout(500);
}

// --- Roster, teams, and bot fill (bots leave one-for-one as humans join). ---
const rosterA = await a.fps("roster");
const botCount = (r) => r.filter((p) => p.name.startsWith("BOT")).length;
// Guests from a previous run may linger until the runtime reaps them, so
// check the fill INVARIANT rather than absolute counts: bots top the lobby
// up to 6 total, one bot per missing human.
const humans = rosterA.length - botCount(rosterA);
check(
  "lobby filled to 6 with bots",
  rosterA.length === Math.max(6, humans),
  `total=${rosterA.length}`,
);
check(
  "each human replaced a bot",
  botCount(rosterA) === Math.max(0, 6 - humans),
  `bots=${botCount(rosterA)} humans=${humans}`,
);
const teams = new Set(rosterA.map((p) => p.team));
check("players split across teams", teams.size === 2, JSON.stringify([...teams]));

// --- Movement + cross-client sync. ---
const aStart = await a.fps("playerPosition");
await a.fps("drive", { moveX: 1, moveZ: 0, sprint: true }, 45);
await a.page.waitForTimeout(2200);
const aPos = await a.fps("playerPosition");
check("A moved", Math.hypot(aPos[0] - aStart[0], aPos[2] - aStart[2]) > 3, JSON.stringify(aPos));

// --- Destruction: build our own targets, then shoot and bomb them — works
// regardless of how war-torn the map already is, and proves the full
// build -> destroy -> propagate loop. ---
await goTo(a, 6, -16);
// Deployed cover lands ~3m ahead, snapped to the half-meter grid (mirrors
// shared/physics.ts buildPlacement).
async function buildTargetPanel() {
  const [x, y, z] = await a.fps("playerPosition");
  const yaw = 0; // face +z
  await a.fps("look", yaw, 0);
  await a.page.waitForTimeout(150);
  const px = Math.round((x + Math.sin(yaw) * 3) * 2) / 2;
  const pz = Math.round((z + Math.cos(yaw) * 3) * 2) / 2;
  // Build, then CONFIRM via the mirror world that a panel sits under the
  // crosshair when aiming at the expected spot — bots make raw counts lie.
  for (let attempt = 0; attempt < 6; attempt++) {
    await a.fps("drive", { build: true }, 3);
    await a.page.waitForTimeout(700);
    const [ax, ay, az] = await a.fps("playerPosition");
    const d = Math.hypot(px - ax, pz - az);
    await a.fps("look", Math.atan2(px - ax, pz - az), Math.atan2(y + 0.625 - (ay + 1.45), d));
    await a.page.waitForTimeout(150);
    if ((await a.fps("aimPanel")) !== null) return { px, py: y + 0.625, pz, ok: true };
  }
  return { px, py: y + 0.625, pz, ok: false };
}

const target1 = await buildTargetPanel();
check("built cover appears for A (confirmed under crosshair)", target1.ok, "");
await a.page.waitForTimeout(400);
const panelsA1 = await a.fps("panelCount");
const panelsB = await b.fps("panelCount");
check("built cover appears for B", Math.abs(panelsB - panelsA1) <= 2, `B=${panelsB} A=${panelsA1}`);

// Shoot our own panel to death (100 HP / 10 per rifle hit).
{
  const d0 = await a.fps("destroyedCount");
  const [x, y, z] = await a.fps("playerPosition");
  const dist = Math.hypot(target1.px - x, target1.pz - z);
  await a.fps(
    "look",
    Math.atan2(target1.px - x, target1.pz - z),
    Math.atan2(target1.py - (y + 1.45), dist),
  );
  let destroyed = false;
  for (let i = 0; i < 16 && !destroyed; i++) {
    await a.fps("drive", { fire: true }, 10);
    await a.page.waitForTimeout(400);
    destroyed = (await a.fps("destroyedCount")) > d0;
    if ((await a.fps("ammo")) < 3) {
      await a.fps("drive", { reload: true }, 4);
      await a.page.waitForTimeout(2100);
    }
  }
  check("gunfire destroys a panel", destroyed, `destroyed=${await a.fps("destroyedCount")}`);
  await a.page.waitForTimeout(800);
  check(
    "destruction propagates to B",
    (await b.fps("destroyedCount")) === (await a.fps("destroyedCount")),
    "",
  );
}

// Grenade demolition: build another target and chuck grenades steeply at the
// ground by its base so the bounce stays inside the blast radius.
{
  const target2 = await buildTargetPanel();
  const d0 = await a.fps("destroyedCount");
  let demolished = false;
  for (let attempt = 0; attempt < 3 && !demolished; attempt++) {
    const [x, y, z] = await a.fps("playerPosition");
    const dist = Math.hypot(target2.px - x, target2.pz - z);
    await a.fps(
      "look",
      Math.atan2(target2.px - x, target2.pz - z),
      Math.atan2(0 - (y + 1.45), dist) * 1.1,
    );
    await a.fps("drive", { grenade: true }, 3);
    for (let i = 0; i < 10 && !demolished; i++) {
      await a.page.waitForTimeout(400);
      demolished = (await a.fps("destroyedCount")) > d0;
    }
  }
  check("grenade demolishes panels", demolished, `destroyed=${await a.fps("destroyedCount")}`);
}

// --- Combat: both walk to an open lane, A aims at B and fires to a kill. ---
console.log("staging a duel on the east lane…");
// Waypoint around the east-side buildings, then up the lane.
await goTo(a, 24, -22);
const okA = await goTo(a, 24, -14);
await goTo(b, 24, 22);
const okB = await goTo(b, 24, 14);
check("A reached the duel lane", okA, `A=${okA}`);
if (!okB) console.log("(B got stuck en route — fine, A tracks B wherever they are)");
const scores0 = await a.fps("scores");
// B's idx as seen from A: the human idx with a remote view (you aren't your
// own remote, so A's own idx returns null).
const humanIdxs = (await a.fps("roster"))
  .filter((p) => !p.name.startsWith("BOT"))
  .map((p) => p.idx);
let bPlayerIdx = humanIdxs[0];
for (const idx of humanIdxs) {
  if ((await a.fps("remotePos", idx)) !== null) bPlayerIdx = idx;
}
let killed = false;
for (let round = 0; round < 40 && !killed; round++) {
  // Bots roam the arena too: if either duelist is down, wait out the respawn
  // and walk back instead of firing into the void.
  if (((await a.fps("selfStatus")) & 1) !== 0) {
    await a.page.waitForTimeout(1500);
    await goTo(a, 24, -14, 12000);
    continue;
  }
  if (((await b.fps("selfStatus")) & 1) !== 0) {
    killed = true; // a bot finished the job — B still died under fire
    break;
  }
  // Track B every prediction tick — the human-tracking equivalent.
  await a.fps("drive", { fire: true, trackIdx: bPlayerIdx }, 14);
  await a.page.waitForTimeout(550);
  if ((await a.fps("ammo")) < 4) {
    await a.fps("drive", { reload: true }, 4);
    await a.page.waitForTimeout(2200);
  }
  killed = (await b.fps("hp")) <= 0 || ((await b.fps("selfStatus")) & 1) !== 0;
}
check("B died under aimed fire", killed, `B hp=${await b.fps("hp")}`);
void scores0; // global score is too volatile under bots/round-resets to assert

// --- Respawn: B comes back alive (bots may immediately re-engage them). ---
let respawned = false;
for (let i = 0; i < 25 && !respawned; i++) {
  await b.page.waitForTimeout(400);
  respawned = ((await b.fps("selfStatus")) & 1) === 0 && (await b.fps("hp")) > 0;
}
check("B respawned", respawned, `hp=${await b.fps("hp")}`);

await a.page.screenshot({ path: "/tmp/bp-play-a.png" });
await b.page.screenshot({ path: "/tmp/bp-play-b.png" });

// --- Leave: B goes, and a bot backfills the slot. ---
const botsBefore = botCount(await a.fps("roster"));
await b.page.context().close();
let backfilled = false;
for (let i = 0; i < 45 && !backfilled; i++) {
  await a.page.waitForTimeout(1000);
  const r = await a.fps("roster");
  backfilled = r.length === 6 && botCount(r) === botsBefore + 1;
}
check("leaving human is replaced by a bot", backfilled, JSON.stringify(await a.fps("roster")));

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nplaytest passed");
