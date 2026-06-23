# Quaternius Toon Shooter Game Kit Assets

Source: https://quaternius.com/packs/toonshootergamekit.html
License: CC0 (free for personal and commercial use).

The full pack's **glTF** models + textures are vendored here, in the pack's
native layout:

- `Characters/glTF/` — `Character_Soldier`, `Character_Enemy`, `Character_Hazmat`
- `Guns/glTF/` — AK, Pistol, Shotgun, SMG, Sniper, RocketLauncher, etc.
- `Environment/glTF/` — 55 props including `Tank.gltf` (the drivable tank)
- `Texture/` — the lone external texture (`Fence.png`); every glTF is otherwise
  self-contained (embedded buffers/images)

The pack's FBX/OBJ/Blend source formats are intentionally **not** checked in —
the web client only loads glTF and they add ~80 MB. Re-download the pack from
the source URL above if you need them.

After adding/removing models, regenerate the manifest:

```sh
node scripts/generate-asset-manifests.mjs
```

`manifest.json` groups the models into `characters`, `weapons`, `environment`,
and `vehicles` (the tank). The client picks the soldier (`/soldier/i`) and
`weapons[0]` (AK) at runtime.
