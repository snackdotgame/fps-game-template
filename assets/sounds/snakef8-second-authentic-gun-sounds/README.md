# SnakeF8 Second Authentic Gun Sounds

Source: https://f8studios.itch.io/snakes-second-authentic-gun-sounds-pack (free,
CC0 — commercial use allowed, credit appreciated).

Only the AK-relevant runtime files are checked in, renamed by the family prefix
the manifest generator reads. From `Snake's SECOND Authentic Gun Sounds.zip`:

| Source file (inside the zip)                          | Checked in as        | Family       |
| ----------------------------------------------------- | -------------------- | ------------ |
| `Isolated/.308 (7.62x51)/WAV/308 Single Isolated.wav` | `shot_rifle_308.wav` | `rifle_shot` |
| `& More/Mag Pack/WAV/AK PolyMag Pack.wav`             | `reload_ak_mag.wav`  | `reload`     |

The .308 single layers a heavier crack into the rifle-shot rotation; the AK
PolyMag adds a reload variant.

After changing the selected sounds, run:

```sh
node scripts/generate-asset-manifests.mjs
```
