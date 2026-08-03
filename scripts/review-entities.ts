// Review every procedurally generated entity, across every curated seed.
//
// Two halves, because the failures come in two flavours:
//
//   1. A structural audit that machines are good at — pieces that float off
//      the ground, pieces detached from the rest of their own structure,
//      degenerate extents. The detached-piece check is the general form of a
//      real bug: cactus arms were stepping out from the trunk with a gap, so
//      they hung in mid-air beside the cactus and nothing caught it.
//   2. A visual contact sheet, because "does this read as an acacia" is not a
//      question with a numeric answer. One elevation per entity, drawn on its
//      true ground line and honouring rot/vis so oriented pieces (palm fronds,
//      pitched roof slabs) show their real silhouette.
//
//   npm run review:entities            audit every seed, write the sheets
//   npm run review:entities -- --quiet just the audit
import { mkdirSync, writeFileSync } from "node:fs";
import {
  baseHeightAt,
  climateName,
  CURATED_MAP_SEEDS,
  initMap,
  isIsland,
  MAP,
  type BuildingDef,
  type PanelDef,
} from "../src/shared/map.js";

const OUT = "scripts/entity-review";
const QUIET = process.argv.includes("--quiet");

// A piece counts as touching another when their boxes overlap or nearly do.
// Generators butt pieces together rather than interpenetrating, so the
// tolerance has to admit a seam without bridging a real gap.
const TOUCH_TOL = 0.14;
// How far a piece may sit above the ground under it before it is "floating".
// Foliage is supposed to be up in the air; this only ever applies to the
// LOWEST piece of an entity, which should be resting on something.
const GROUND_TOL = 0.35;

interface Finding {
  seed: number;
  climate: string;
  sub: string;
  id: number;
  kind: string;
  detail: string;
}

function piecesOf(byId: Map<number, PanelDef[]>, b: BuildingDef): PanelDef[] {
  return byId.get(b.id) ?? [];
}

function touching(a: PanelDef, b: PanelDef): boolean {
  return (
    Math.abs(a.x - b.x) - (a.ex + b.ex) / 2 < TOUCH_TOL &&
    Math.abs(a.y - b.y) - (a.ey + b.ey) / 2 < TOUCH_TOL &&
    Math.abs(a.z - b.z) - (a.ez + b.ez) / 2 < TOUCH_TOL
  );
}

// Flood from every piece that reaches the ground; anything unreached is a
// fragment hanging in the air with nothing joining it to the structure.
function detachedPieces(ps: PanelDef[]): PanelDef[] {
  if (ps.length === 0) return [];
  const grounded: number[] = [];
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].y - ps[i].ey / 2 <= baseHeightAt(ps[i].x, ps[i].z) + GROUND_TOL) grounded.push(i);
  }
  if (grounded.length === 0) return []; // whole-entity float, reported separately
  const seen = new Set(grounded);
  const stack = [...grounded];
  while (stack.length > 0) {
    const i = stack.pop()!;
    for (let j = 0; j < ps.length; j++) {
      if (seen.has(j) || !touching(ps[i], ps[j])) continue;
      seen.add(j);
      stack.push(j);
    }
  }
  return ps.filter((_, i) => !seen.has(i));
}

function rotMat(q: readonly [number, number, number, number]): number[][] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

const SWATCH: Record<string, string> = {
  brick: "#b06a4c",
  adobe: "#c9a97c",
  log: "#8a6a44",
  plank: "#9c7c52",
  post: "#6b5233",
  trunk: "#6b5233",
  canopy: "#3f8a34",
  frond: "#2f7a2c",
  bough: "#2c6b3a",
  concrete: "#a8abaf",
  glass: "#cfe7f2",
  stone: "#9a958c",
  stair: "#7a6a54",
  sandbag: "#9a8f72",
  metal: "#8a949e",
  rock: "#5a5a60",
  crate: "#9a7a52",
  rubble: "#847d72",
};

// One entity, drawn front-on with its ground line. `axis` picks which
// horizontal axis maps to screen x, so a structure can be seen from both sides.
function drawEntity(
  ps: PanelDef[],
  ox: number,
  oy: number,
  scale: number,
  axis: "x" | "z",
): string[] {
  const out: string[] = [];
  // Centre on the drawn EXTENT, not on the mean piece position. A roundhut's
  // doorway deletes the lower courses of one facet, which drags the centroid
  // off-axis and pushed the hut half out of its own cell.
  let uMin = Infinity;
  let uMax = -Infinity;
  for (const p of ps) {
    const u = axis === "x" ? p.x : p.z;
    const h = (axis === "x" ? p.ex : p.ez) / 2;
    uMin = Math.min(uMin, u - h);
    uMax = Math.max(uMax, u + h);
  }
  const cu = (uMin + uMax) / 2;
  // The ground line is sampled under the piece that actually RESTS on it, not
  // under the centroid. A tree's centroid is up in its crown and pushed off the
  // trunk by the crown's asymmetry and lean, so on any slope the centroid
  // sample came from the wrong patch of ground: the drawn line sat below a
  // perfectly grounded broadleaf and above a perfectly grounded conifer. The
  // numeric audit samples per piece and was never affected, which is exactly
  // how a clean audit shipped alongside a picture of a floating tree.
  let low = ps[0];
  for (const p of ps) if (p.y - p.ey / 2 < low.y - low.ey / 2) low = p;
  const ground = baseHeightAt(low.x, low.z);
  const depth = (p: PanelDef): number => (axis === "x" ? p.z : -p.x);
  for (const p of [...ps].sort((a, b) => depth(a) - depth(b))) {
    const [sx, sy, sz] = p.vis ?? [p.ex, p.ey, p.ez];
    const R = p.rot
      ? rotMat(p.rot)
      : [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ];
    const pts: [number, number][] = [];
    for (const dx of [-0.5, 0.5]) {
      for (const dy of [-0.5, 0.5]) {
        for (const dz of [-0.5, 0.5]) {
          const v = [dx * sx, dy * sy, dz * sz];
          const wx = p.x + R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2];
          const wy = p.y + R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2];
          const wz = p.z + R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2];
          pts.push([ox + ((axis === "x" ? wx : wz) - cu) * scale, oy - (wy - ground) * scale]);
        }
      }
    }
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: number[], a: number[], b: number[]): number =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (src: [number, number][]): [number, number][] => {
      const h: [number, number][] = [];
      for (const q of src) {
        while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
        h.push(q);
      }
      return h;
    };
    const hull = [...half(pts).slice(0, -1), ...half([...pts].reverse()).slice(0, -1)];
    out.push(
      `<polygon points="${hull.map((q) => q.map((n) => n.toFixed(1)).join(",")).join(" ")}" fill="${
        SWATCH[p.material] ?? "#888"
      }" fill-opacity="0.94" stroke="#0002" stroke-width="0.4"/>`,
    );
  }
  return out;
}

// --- Run --------------------------------------------------------------------

const findings: Finding[] = [];
const census = new Map<string, { n: number; pieces: number; seeds: Set<number> }>();
const sheets: string[] = [];

for (const seed of CURATED_MAP_SEEDS) {
  initMap(seed);
  const climate = `${climateName()}${isIsland() ? " (island)" : ""}`;
  const byId = new Map<number, PanelDef[]>();
  for (const b of MAP.buildings) byId.set(b.id, []);
  for (const p of MAP.panels) {
    if (p.buildingId === undefined) continue;
    byId.get(p.buildingId)?.push(p);
  }

  // One representative of each generator, for the visual sheet.
  const seen = new Map<string, BuildingDef>();

  for (const b of MAP.buildings) {
    const ps = piecesOf(byId, b);
    const sub = b.sub ?? b.kind;
    const c = census.get(sub) ?? { n: 0, pieces: 0, seeds: new Set<number>() };
    c.n++;
    c.pieces += ps.length;
    c.seeds.add(seed);
    census.set(sub, c);
    if (!seen.has(sub) && ps.length > 0) seen.set(sub, b);

    const note = (detail: string): void => {
      findings.push({ seed, climate, sub, id: b.id, kind: b.kind, detail });
    };
    if (ps.length === 0) {
      note("registered with no pieces");
      continue;
    }
    // Whole entity off the ground.
    let lowest = Infinity;
    for (const p of ps) lowest = Math.min(lowest, p.y - p.ey / 2 - baseHeightAt(p.x, p.z));
    if (lowest > GROUND_TOL) note(`floats ${lowest.toFixed(2)}m clear of the ground`);
    // Degenerate geometry.
    for (const p of ps) {
      if (p.ex <= 0.01 || p.ey <= 0.01 || p.ez <= 0.01) {
        note(`piece ${p.id} has a zero extent (${p.ex}, ${p.ey}, ${p.ez})`);
        break;
      }
      if (Math.max(p.ex, p.ey, p.ez) > 30) {
        note(`piece ${p.id} is ${Math.max(p.ex, p.ey, p.ez).toFixed(1)}m across`);
        break;
      }
    }
    // Pieces with nothing joining them to the rest of the structure.
    const loose = detachedPieces(ps);
    if (loose.length > 0) {
      const frac = ((100 * loose.length) / ps.length).toFixed(0);
      // Name the offender and how wide the gap is, or the report only tells
      // you that something is broken and not what to go and look at.
      const p0 = loose[0];
      let near = Infinity;
      for (const q of ps) {
        if (q === p0) continue;
        const d = Math.max(
          Math.abs(p0.x - q.x) - (p0.ex + q.ex) / 2,
          Math.abs(p0.y - q.y) - (p0.ey + q.ey) / 2,
          Math.abs(p0.z - q.z) - (p0.ez + q.ez) / 2,
        );
        near = Math.min(near, d);
      }
      const mats = [...new Set(loose.map((q) => q.material))].join("/");
      note(
        `${loose.length}/${ps.length} pieces (${frac}%) detached [${mats}], ` +
          `worst gap ${near.toFixed(2)}m`,
      );
    }
  }

  if (!QUIET) {
    const entries = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const CW = 300;
    const CH = 300;
    const cols = 4;
    const rows = Math.ceil(entries.length / cols);
    const svg: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * CW}" height="${rows * CH + 34}" viewBox="0 0 ${cols * CW} ${rows * CH + 34}">`,
      `<rect width="100%" height="100%" fill="#d3e1ea"/>`,
      `<text x="10" y="22" font-family="monospace" font-size="16" fill="#123">${climate} — seed ${seed} — one of each generator</text>`,
    ];
    entries.forEach(([sub, b], i) => {
      const ps = piecesOf(byId, b);
      const ox = (i % cols) * CW + CW / 2;
      const oy = 34 + Math.floor(i / cols) * CH + CH - 40;
      let hi = 0;
      for (const p of ps) hi = Math.max(hi, p.y + p.ey / 2 - baseHeightAt(p.x, p.z));
      // Scale to what actually gets DRAWN. Taken from the building's declared
      // footprint, anything that oversails it — a roundhut's thatch, a deep
      // eave — was scaled as if it were narrower than it is and had its edges
      // cropped off at the cell boundary, which is the one thing a review
      // sheet must never do quietly.
      const axis: "x" | "z" = b.w >= b.d ? "x" : "z";
      let lo = Infinity;
      let hiU = -Infinity;
      for (const p of ps) {
        const u = axis === "x" ? p.x : p.z;
        const h = (axis === "x" ? p.ex : p.ez) / 2;
        lo = Math.min(lo, u - h);
        hiU = Math.max(hiU, u + h);
      }
      const wide = Math.max(hiU - lo, 4);
      const scale = Math.min((CW - 40) / wide, (CH - 80) / Math.max(hi, 3));
      svg.push(...drawEntity(ps, ox, oy, scale, axis));
      svg.push(
        `<line x1="${ox - CW / 2 + 14}" y1="${oy}" x2="${ox + CW / 2 - 14}" y2="${oy}" stroke="#b04" stroke-width="1.4"/>`,
      );
      svg.push(
        `<text x="${ox - CW / 2 + 14}" y="${oy + 20}" font-family="monospace" font-size="13" fill="#234">${sub} · ${ps.length} pieces</text>`,
      );
    });
    svg.push("</svg>");
    mkdirSync(OUT, { recursive: true });
    const file = `${climateName().toLowerCase()}${isIsland() ? "-island" : ""}.svg`;
    writeFileSync(`${OUT}/${file}`, svg.join("\n"));
    sheets.push(file);
  }
}

if (!QUIET) {
  writeFileSync(
    `${OUT}/index.html`,
    `<style>body{margin:0;background:#1d1f22;font-family:monospace}img{width:100%;display:block;margin-bottom:6px}</style>` +
      sheets.map((f) => `<img src="${f}">`).join("\n"),
  );
}

console.log("entity census across all curated seeds");
for (const [sub, c] of [...census.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    `  ${sub.padEnd(12)} ${String(c.n).padStart(5)} built  ` +
      `${String(Math.round(c.pieces / c.n)).padStart(4)} pieces each  ` +
      `${c.seeds.size}/${CURATED_MAP_SEEDS.length} maps`,
  );
}

// Every generator has to actually fire somewhere in the shipped set. This is
// worth asserting rather than eyeballing: silos, tanks and towers were each
// being built once across all eleven maps because of placement bugs nothing
// else could see, and a generator that never runs is a generator nobody is
// reviewing. RARE is the honest floor — some kinds are deliberately scarce.
const EXPECTED: readonly string[] = [
  // lot kinds
  "house",
  "tower",
  "barn",
  "ruin",
  "longhouse",
  "granary",
  "compound",
  "roundhut",
  "stilt",
  "shed",
  "silo",
  "tank",
  // a compound's wall is its own structure
  "courtyard",
  // tree forms
  "conifer",
  "broadleaf",
  "palm",
  "acacia",
  "cactus",
  "snag",
  "emergent",
];
const RARE = 3;
const absent = EXPECTED.filter((k) => !census.has(k));
const scarce = EXPECTED.filter((k) => (census.get(k)?.n ?? 0) > 0 && census.get(k)!.n < RARE);
if (absent.length > 0) console.log(`\nNEVER BUILT: ${absent.join(", ")}`);
if (scarce.length > 0)
  console.log(`\nbarely built (<${RARE} across all maps): ${scarce.join(", ")}`);
const unknown = [...census.keys()].filter((k) => !EXPECTED.includes(k));
if (unknown.length > 0) console.log(`\nnot in the expected list: ${unknown.join(", ")}`);

if (findings.length === 0) {
  console.log("\nno structural problems found");
} else {
  // Group so one systemic bug doesn't print a thousand times.
  const byDetail = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.sub}: ${f.detail.replace(/\d+(\.\d+)?/g, "N")}`;
    const list = byDetail.get(key);
    if (list) list.push(f);
    else byDetail.set(key, [f]);
  }
  console.log(`\n${findings.length} structural finding(s), ${byDetail.size} distinct:`);
  for (const [key, list] of [...byDetail.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const ex = list[0];
    console.log(`  [${String(list.length).padStart(4)}x] ${key}`);
    console.log(`           e.g. ${ex.climate} seed ${ex.seed} entity ${ex.id}: ${ex.detail}`);
  }
}
if (!QUIET) console.log(`\nsheets: ${OUT}/index.html`);
