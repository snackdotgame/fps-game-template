# Quaternius Toon Shooter Game Kit Runtime Assets

Source: https://quaternius.com/packs/toonshootergamekit.html

Only runtime files used by this template are checked in:

- `characters/soldier.gltf`
- `weapons/ak.gltf`

After changing the selected models, run:

```sh
node scripts/generate-asset-manifests.mjs
```

The generated `manifest.json` lists model files that the client loads at runtime.
