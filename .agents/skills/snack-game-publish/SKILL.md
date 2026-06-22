---
name: snack-game-publish
description: Use when preparing, deploying, or publishing a generated Snack.Game project with the Snack CLI, including auth checks, snack.json metadata, build verification, and publish troubleshooting.
---

# Snack Game Publish

Use this skill only when the user explicitly asks to publish, deploy, release, or prepare a
generated Snack.Game project for hosting.

## Read First

Read:

- `AGENTS.md`
- `snack.json`
- `package.json`
- `src/client.ts`
- `src/server.ts`
- `src/shared/*`

Identify the package manager from `package.json.packageManager` and use that package manager for
scripts.

## `snack.json`

The scaffolded config has this shape:

```json
{
  "$schema": "./node_modules/@snack-game/cli/snack.schema.json",
  "version": 1,
  "game": {
    "id": "optional-existing-game-id",
    "name": "Optional Display Name",
    "slug": "optional-url-slug",
    "description": "Optional public description",
    "visibility": "private",
    "maxPlayers": {
      "lowerLimit": 1,
      "upperLimit": 16,
      "default": 16
    },
    "serverConfigSchema": {
      "allowBots": { "type": "boolean", "default": false },
      "mode": { "type": "string", "default": "ranked" },
      "speed": { "type": "number", "default": 3 }
    },
    "titleImage": "title.svg",
    "genre": "platformer",
    "tags": ["local-multiplayer"]
  },
  "server": {
    "entry": "src/server.ts"
  },
  "client": {
    "entry": "src/client.ts"
  },
  "assets": {
    "directory": "assets"
  }
}
```

Supported fields:

- `$schema`: optional JSON Schema reference for editor validation and completions. Generated
  projects point this at `./node_modules/@snack-game/cli/snack.schema.json`, matching Wrangler's
  local package schema pattern.
- `version`: config schema version. Keep this as `1`.
- `game`: public game metadata object. If missing, publish can still infer defaults, but generated
  projects should keep this object.
- `game.id`: existing hosted game ID. If absent, first publish creates a game and writes the returned
  ID back to `snack.json`.
- `game.name`: display name used when creating a game. Defaults to a humanized package or directory
  name. The API accepts up to 100 characters.
- `game.slug`: optional URL slug used when creating a game. Use lowercase letters, numbers, and
  single hyphens. The API accepts up to 64 characters.
- `game.description`: optional public description used when creating a game. The API accepts up to
  1000 characters.
- `game.visibility`: `private`, `unlisted`, or `public`. Defaults to `private`.
- `game.maxPlayers`: player capacity range. Set `lowerLimit`, `upperLimit`, and `default`
  between `1` and `128`; `default` must be within the range. Legacy integer values are normalized
  as `{ "lowerLimit": 1, "upperLimit": value, "default": value }`.
- `game.serverConfigSchema`: optional flat schema object with up to 20 server config fields. Each
  field must define `type` (`boolean`, `number`, or `string`) and a matching `default` value.
  Optional `label` and `description` strings can be used by creator/player UI. Keep it at or below
  4096 bytes; the game server reads the merged per-session value snapshot through `server.config`.
- `game.titleImage`: optional image under `assets/`, for example `title.svg` or
  `assets/title.svg`. It must not start with `/` or `./`, must not contain backslashes or path
  traversal, must exist in `assets/`, and must have an image content type.
- `game.genre`: optional genre. Allowed values are `action`, `adventure`, `education`,
  `entertainment`, `platformer`, `party-casual`, `puzzle`, `rpg`, `roleplay`, `shooter`,
  `shopping`, `simulation`, `social`, `sports-racing`, `strategy`, `survival`, and
  `utility-other`.
- `game.tags`: optional array of up to 12 tags. Tags are normalized to lowercase, deduplicated, and
  must use lowercase letters, numbers, and single hyphens. Each tag can be up to 32 characters.
- `server.entry`: server entrypoint used by `snack dev` and `snack build`. It must point to an
  existing file and that file must export `main()`.
- `client.entry`: client entrypoint in the scaffold contract. Keep this as `src/client.ts` unless
  the Vite config is also updated, because the generated Vite config loads `/src/client.ts`.
- `assets.directory`: assets directory in the scaffold contract. Keep this as `assets` because the
  generated Vite config and publish flow serve and copy the root `assets/` directory.

Deployment target settings do not belong in `snack.json`. Use CLI flags, saved auth credentials, or
environment variables instead.

## Preflight

Check that:

- `game.maxPlayers` matches the intended room capacity.
- `game.titleImage`, when present, points to an image file under `assets/`.
- Publishable assets are not symlinks.
- The deploy manifest has at most 512 files, each file is at most 10 MiB, and unique content blobs
  are at most 50 MiB total.
- Client and server entrypoints still match the scaffold contract.
- The project has `@snack-game/cli` installed as a dev dependency.

Run:

```sh
<package-manager> run check
<package-manager> run build
```

Use the actual package manager command, such as `npm`, `pnpm`, `bun`, or `yarn`.

## Authentication

Check auth before publishing:

```sh
snack auth whoami
```

If credentials are missing and the user wants to continue, run:

```sh
snack auth login
```

For CI or explicit automation, Snack can read:

- `SNACK_API_URL`
- `SNACK_WORKSPACE_ID`
- `SNACK_TOKEN`
- `SNACK_GAME_ID`

The equivalent publish flags are `--api-url`, `--workspace-id`, `--token`, `--game-id`, and
`--message`.

## Publish

Use `publish` for the normal creator workflow:

```sh
<package-manager> run publish
```

`publish` builds local client/server artifacts, uploads the immutable game version, and activates it
for play.

Use `deploy` only for lower-level upload/debug flows:

```sh
<package-manager> run deploy
```

## Troubleshooting

- If type declarations for `snack:client` or `snack:server` are missing, run `snack build` or the
  project build script to regenerate `.snack/types`.
- If the local game does not connect, test through `http://127.0.0.1:3030/`, not the Vite-only port.
- If publish fails on missing auth, rerun `snack auth whoami` and verify env vars or saved
  credentials.
- If publish fails on assets, check `assets/` paths, symlinks, the 512 file limit, the 10 MiB
  per-file limit, the 50 MiB total unique-blob limit, and `game.titleImage`.
