---
name: snack-configure-project
description: Configure and repair generated Snack.Game projects. Use when changing snack.json, entrypoints, assets metadata, player capacity, server config schema or room settings, dev ports, client/server/shared boundaries, or server-compatible dependencies, and when diagnosing restricted-runtime build failures.
---

# Configure A Snack.Game Project

Keep the generated project compatible with the Snack scaffold, browser client, restricted server
runtime, and project-owned package scripts.

## Inspect The Project

Read before editing:

- `AGENTS.md`
- `snack.json`
- `package.json`
- the affected files under `src/client.ts`, `src/server.ts`, and `src/shared/`
- `.snack/types/client.d.ts` or `.snack/types/server.d.ts` when relying on a Snack API
- `node_modules/@snack-game/cli/snack.schema.json` when dependencies are installed

Treat the project-pinned schema and generated declarations as authoritative for the installed CLI
version. Do not guess fields or APIs from memory.

## Classify The Change

Place code according to its execution environment:

- Keep rendering, DOM, audio, input, and browser libraries in client code.
- Keep authoritative state, validation, timing, and multiplayer rules in server code.
- Keep only environment-neutral types, constants, protocol definitions, and pure helpers in
  `src/shared/`.
- Keep package installation, typechecking, linting, formatting, and orchestration in package
  scripts. Do not invent Snack CLI wrappers for them.

Read [references/server-runtime.md](references/server-runtime.md) before adding a server dependency,
moving code across an environment boundary, or fixing a server bundle/runtime error.

## Change `snack.json` Safely

1. Preserve fields unrelated to the request.
2. Keep the root `version` as the config schema version; do not use it as a game release number.
3. Validate values against the project-pinned JSON Schema.
4. Keep `server.entry`, `client.entry`, and `assets.directory` aligned with the actual build setup.
5. Treat `game.maxPlayers`, `game.serverConfigSchema`, metadata, and platform declarations as
   product contracts rather than comments.
6. Prefer additive changes. Do not silently reinterpret legacy accepted values.

Read [references/snack-json.md](references/snack-json.md) for field semantics, room configuration,
metadata, and dev-port precedence.

## Check Runtime Compatibility

- Import `client` from `snack:client` in browser code.
- Import `server` from `snack:server` and export `main()` from server code.
- Use the generated channel APIs; do not wire raw WebTransport, `/connect-info`, or launch
  `postMessage` handling.
- Do not add filesystem, process, environment, subprocess, native-addon, raw-socket, server-listener,
  unmanaged-worker, or outbound-fetch assumptions to server code.
- Prefer pure JavaScript or browser-compatible dependencies for server code.
- Keep loops cooperative with `server.sleep()` or blocking channel receives.

## Verify

Use the package manager from `package.json.packageManager`.

Run the project-owned scripts:

```sh
<package-manager> run check
<package-manager> run build
```

If a script is absent, report that fact instead of substituting a new Snack command. Explain any
remaining client/server compatibility risk.
