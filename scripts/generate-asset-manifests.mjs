import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const assetRoot = path.join(root, "assets");

async function walk(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const file = path.join(dir, entry);
    const info = await stat(file);
    if (info.isDirectory()) out.push(...(await walk(file)));
    else out.push(file);
  }
  return out;
}

function assetUrl(file) {
  return `/${path.relative(root, file).split(path.sep).join("/")}`;
}

function includesAny(value, needles) {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function extensionRank(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".gltf")) return 0;
  if (lower.endsWith(".glb")) return 1;
  if (lower.endsWith(".fbx")) return 2;
  if (lower.endsWith(".obj")) return 3;
  return 4;
}

function rankedAssetUrls(files, rankFile) {
  return [...files]
    .sort((a, b) => {
      const byRank = rankFile(a) - rankFile(b);
      if (byRank !== 0) return byRank;

      const byExtension = extensionRank(a) - extensionRank(b);
      if (byExtension !== 0) return byExtension;

      return a.localeCompare(b);
    })
    .map(assetUrl);
}

const modelRoot = path.join(assetRoot, "vendor", "quaternius-toon-shooter");
const modelFiles = (await walk(modelRoot)).filter((file) => /\.(glb|gltf|fbx|obj)$/i.test(file));
function modelPath(file) {
  return `/${path.relative(modelRoot, file).split(path.sep).join("/")}`.toLowerCase();
}

const characterFiles = modelFiles.filter((file) =>
  includesAny(modelPath(file), [
    "/characters/",
    "character",
    "soldier",
    "player",
    "human",
    "swat",
    "enemy",
  ]),
);
const weaponFiles = modelFiles.filter((file) =>
  includesAny(modelPath(file), [
    "/guns/",
    "/weapons/",
    "ak",
    "gun",
    "rifle",
    "weapon",
    "pistol",
    "shotgun",
    "smg",
  ]),
);
const characters = rankedAssetUrls(characterFiles, (file) => {
  const lower = modelPath(file);
  if (lower.includes("/characters/soldier.gltf")) return 0;
  if (lower.includes("/characters/gltf/character_soldier.gltf")) return 0;
  if (lower.includes("/characters/") && lower.includes("soldier")) return 1;
  if (lower.includes("/characters/")) return 2;
  return 3;
});
const weapons = rankedAssetUrls(weaponFiles, (file) => {
  const lower = modelPath(file);
  if (lower.includes("/weapons/ak.gltf")) return 0;
  if (lower.includes("/guns/gltf/ak.gltf")) return 0;
  if (lower.includes("/guns/") && includesAny(lower, ["ak", "smg", "rifle"])) return 1;
  if (lower.includes("/weapons/")) return 1;
  if (lower.includes("/guns/")) return 2;
  return 3;
});
await writeFile(
  path.join(modelRoot, "manifest.json"),
  `${JSON.stringify({ characters, weapons }, null, 2)}\n`,
);

const soundFiles = (await walk(path.join(assetRoot, "sounds"))).filter((file) =>
  /\.(wav|ogg|mp3|m4a)$/i.test(file),
);
// Gun-sound families are curated by filename prefix. Drop f8studios files into
// the snakef8-* folders named shot_* (dry single cracks), tail_* (reverb body
// layered under each shot), or reload_* (mag/charging). Kenney impacts back the
// melee family. See the snakef8-* READMEs for the extraction recipe.
const baseName = (file) => file.toLowerCase().split(path.sep).pop();
const families = {
  rifle_shot: soundFiles.filter((file) => baseName(file).startsWith("shot_")),
  rifle_tail: soundFiles.filter((file) => baseName(file).startsWith("tail_")),
  reload: soundFiles.filter((file) => baseName(file).startsWith("reload_")),
  melee: soundFiles.filter((file) => includesAny(baseName(file), ["melee", "punch", "impact"])),
  death: soundFiles.filter((file) => baseName(file).startsWith("death_")),
};
await writeFile(
  path.join(assetRoot, "sounds", "manifest.json"),
  `${JSON.stringify(
    {
      families: Object.fromEntries(
        Object.entries(families).map(([key, files]) => [key, files.map(assetUrl)]),
      ),
    },
    null,
    2,
  )}\n`,
);

console.log(`Wrote ${characters.length} character model(s), ${weapons.length} weapon model(s).`);
console.log(
  `Wrote sound families: ${Object.entries(families)
    .map(([key, files]) => `${key}=${files.length}`)
    .join(", ")}`,
);
