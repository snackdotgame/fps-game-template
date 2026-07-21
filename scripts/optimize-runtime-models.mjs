import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, resample, sparse, weld } from "@gltf-transform/functions";
import { ready as resampleReady, resample as resampleKeyframes } from "keyframe-resample";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const root = process.cwd();
const outputDir = path.join(root, "assets", "runtime-models");
const requiredCharacterNodes = ["AK", "SMG", "Shotgun", "Sniper", "Pistol", "Revolver"];
const requiredCharacterClips = [
  "Death",
  "Duck",
  "HitReact",
  "Idle",
  "Idle_Shoot",
  "Jump",
  "Jump_Idle",
  "Jump_Land",
  "No",
  "Punch",
  "Run",
  "Run_Gun",
  "Run_Shoot",
  "Walk",
  "Walk_Shoot",
  "Wave",
  "Yes",
];
const models = [
  {
    input: "assets/vendor/quaternius-toon-shooter/Characters/glTF/Character_Soldier.gltf",
    output: "Character_Soldier.glb",
  },
  { input: "assets/vendor/quaternius-toon-shooter/Guns/glTF/AK.gltf", output: "AK.glb" },
  { input: "assets/vendor/quaternius-toon-shooter/Guns/glTF/SMG.gltf", output: "SMG.glb" },
  {
    input: "assets/vendor/quaternius-toon-shooter/Guns/glTF/Shotgun.gltf",
    output: "Shotgun.glb",
  },
  {
    input: "assets/vendor/quaternius-toon-shooter/Guns/glTF/Sniper.gltf",
    output: "Sniper.glb",
  },
  {
    input: "assets/vendor/quaternius-toon-shooter/Guns/glTF/Pistol.gltf",
    output: "Pistol.glb",
  },
  {
    input: "assets/vendor/quaternius-toon-shooter/Guns/glTF/Revolver.gltf",
    output: "Revolver.glb",
  },
  { input: "assets/vendor/kenney/grenade.glb", output: "grenade.glb" },
];

await mkdir(outputDir, { recursive: true });
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, resampleReady]);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
  "meshopt.encoder": MeshoptEncoder,
});

for (const model of models) {
  const input = path.join(root, model.input);
  const output = path.join(outputDir, model.output);
  const document = await io.read(input);

  // Keep scene structure and mesh density intact. Runtime code relies on the
  // Soldier's named weapon nodes and animation clips, so this pass focuses on
  // lossless deduplication plus mesh/animation quantization and compression.
  await document.transform(
    dedup(),
    weld(),
    resample({ ready: resampleReady, resample: resampleKeyframes }),
    prune({
      keepAttributes: false,
      keepIndices: false,
      keepLeaves: false,
      keepSolidTextures: false,
    }),
    sparse(),
    meshopt({ encoder: MeshoptEncoder, level: "high" }),
  );
  validateRuntimeStructure(model.output, document.getRoot());
  await io.write(output, document);

  const [sourceInfo, outputInfo] = await Promise.all([stat(input), stat(output)]);
  const reduction = Math.round((1 - outputInfo.size / sourceInfo.size) * 100);
  console.log(
    `${model.output}: ${formatBytes(sourceInfo.size)} -> ${formatBytes(outputInfo.size)} (${reduction}% smaller)`,
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function validateRuntimeStructure(output, modelRoot) {
  assert.ok(modelRoot.listMeshes().length > 0, `${output} must contain a mesh`);
  if (output !== "Character_Soldier.glb") return;

  const nodeNames = new Set(modelRoot.listNodes().map((node) => node.getName()));
  const clipNames = new Set(modelRoot.listAnimations().map((clip) => clip.getName()));
  for (const name of requiredCharacterNodes) {
    assert.ok(nodeNames.has(name), `Character_Soldier.glb lost weapon node ${name}`);
  }
  for (const name of requiredCharacterClips) {
    assert.ok(clipNames.has(name), `Character_Soldier.glb lost animation clip ${name}`);
  }
  assert.equal(modelRoot.listSkins().length, 1, "Character_Soldier.glb must retain its skin");
}
