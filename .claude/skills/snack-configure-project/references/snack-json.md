# `snack.json` Reference

Use the project's `$schema` target as the exact source for allowed fields and validation. This
reference explains how the fields participate in Snack workflows.

## Top-Level Contract

| Field              | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `$schema`          | Editor validation against the project-local CLI package.                                  |
| `version`          | Snack config schema version. Generated projects use `1`; it is not a pushed game version. |
| `game`             | Hosted game identity, public metadata, capacity, and room configuration.                  |
| `server.entry`     | Restricted-runtime entrypoint. It must exist and export `main()`.                         |
| `client.entry`     | Browser entrypoint. Keep it aligned with the Vite config.                                 |
| `assets.directory` | Root static asset directory. The generated scaffold requires `assets`.                    |
| `dev`              | Optional local Snack host-shell and Vite client ports.                                    |

The JSON Schema rejects unknown properties in editors and schema-aware tools. The CLI currently
parses the manifest as JSON and validates the fields used by each command; do not assume every
unknown or misspelled property will fail a build or push. Preserve valid existing fields and check
schema diagnostics when making a focused change.

## Game Identity And Versions

- `game.id` identifies an existing hosted game. First push can create a game and write the id back.
- `game.versionId` selects the default immutable pushed version for `snack publish`. `snack push`
  writes it after finalization.
- `game.versionName` names the next pushed immutable version. Set it before pushing; do not put a
  pushed version number in the root `version`.
- `game.name`, `slug`, and `description` become hosted product metadata. Use the schema for current
  length and format constraints.
- `game.visibility` accepts `private`, `unlisted`, or `public`. Publishing promotes a pushed version
  to the public live channel.

Remote target values do not belong in `snack.json`. Use saved credentials, environment variables,
or CLI flags for API URL, workspace, token, and explicit game overrides.

## Capacity And Room Settings

`game.maxPlayers` is a range:

```json
{
  "lowerLimit": 1,
  "upperLimit": 16,
  "default": 8
}
```

All values must be integers from 1 through 128, `lowerLimit <= upperLimit`, and `default` must be
inside the range. Legacy integer values remain accepted; do not rewrite them unless the task needs
the range form.

`game.serverConfigSchema` defines optional per-session settings. It is a flat object with at most
20 fields and a serialized limit of 4096 bytes. Each field:

- has a non-reserved key
- uses `boolean`, `number`, or `string`
- provides a matching `default`
- may provide a short `label` and `description`

The host merges selected values with defaults and exposes the deeply frozen snapshot as
`server.config`. Validate once at the manifest/control-plane boundary and still treat values
defensively in gameplay code.

## Assets And Discovery Metadata

- `game.titleImage` is required for push. Point it to an image under `assets/` using a safe relative
  path such as `title.svg` or `assets/title.svg`.
- `game.genre` is required before launching a hosted preview/server. Read the schema for the current
  enum.
- `game.platforms` contains `desktop`, `phone`, and/or `tablet`. Claim phone or tablet only after
  touch controls and the corresponding viewport work.
- `game.tags` contains at most 12 normalized lowercase kebab-case tags, each no longer than 32
  characters.

Do not use metadata as a substitute for implementation. Capacity, room config, assets, and device
support must match the game.

## Entrypoints And Assets

- Keep the default server entry at `src/server.ts` unless the build and project layout intentionally
  change together.
- Keep the client entry at `src/client.ts` unless `vite.config.ts` is updated too; the generated
  Vite setup loads that file.
- Keep `assets.directory` as `assets`; local dev and build/push copy and serve this root directory.
- Keep publishable assets as regular files rather than symlinks.

## Dev Ports

The resolution order is:

1. `snack dev --port` and `--client-port`
2. `SNACK_DEV_PORT`, `SNACK_CLIENT_PORT`, and `SNACK_CLIENT_HOST`
3. `snack.json` `dev.port` and `dev.clientPort`
4. defaults: Snack host shell `3030`, Vite client `3031`

Changing ports does not change the rule that gameplay testing must use the Snack host shell rather
than the Vite-only URL.
