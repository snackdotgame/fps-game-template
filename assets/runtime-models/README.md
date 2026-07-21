# Runtime model assets

These GLBs are generated from the CC0 Quaternius Toon Shooter models and the
CC0 Kenney grenade under `assets/vendor/`. They retain the source scene graph,
mesh density, materials, named Soldier weapon nodes, skin, and animation clips.

The generated files use `EXT_meshopt_compression` and
`KHR_mesh_quantization`. Regenerate them after changing the source models:

```sh
npm run optimize:models
```

The browser must register Three.js's `MeshoptDecoder` with `GLTFLoader` before
loading these files.
