# SnakeF8 Authentic Gun Sounds

Source: https://f8studios.itch.io/snakes-authentic-gun-sounds (free, CC0 —
commercial use allowed, credit appreciated).

The full pack ships dozens of calibers in WAV+MP3. Only the AK-relevant runtime
files are checked in, renamed by the family prefix the manifest generator reads
(`shot_*`, `tail_*`, `reload_*`). From `Snake's Authentic Gun Sounds And More.zip`:

| Source file (inside the zip)                          | Checked in as        | Family       |
| ----------------------------------------------------- | -------------------- | ------------ |
| `Isolated/7.62x39/WAV/762x39 Single Isolated WAV.wav` | `shot_ak_762.wav`    | `rifle_shot` |
| `Full Sound/7.62x39/WAV/762x39 Single WAV.wav`        | `tail_ak_762.wav`    | `rifle_tail` |
| `Reloads, Cycling & More/WAV/AK Reload Full WAV.wav`  | `reload_ak_full.wav` | `reload`     |
| `Reloads, Cycling & More/WAV/AK Rack WAV.wav`         | `reload_ak_rack.wav` | `reload`     |

After changing the selected sounds, run:

```sh
node scripts/generate-asset-manifests.mjs
```
