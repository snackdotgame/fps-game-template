# Snack Push, Preview, And Publish Reference

## Version Semantics

- The root `version` in `snack.json` is the config schema version, not a game release number.
- `game.versionName` is an optional display name for the next pushed version.
- `snack push` creates an immutable version and writes its UUID to `game.versionId` when possible.
- `snack versions` lists pushed versions and their immutable ids.
- `snack preview [version-id]` launches an unlisted server. Without an id it selects the latest
  ready pushed version.
- `snack publish [version-id]` makes a pushed version public/live. Without an id it uses
  `game.versionId`.
- Running sessions remain on their existing version; publication changes the live version for new
  public launches.

## Publish-Relevant Manifest Fields

- `game.id`: hosted game identity; first push may create it.
- `game.versionId`: default version selected by publish.
- `game.versionName`: name applied to the next push.
- `game.titleImage`: required image under `assets/` for push and directory presentation.
- `game.genre`: required before previewing or launching a hosted server.
- `game.maxPlayers`: supported room-capacity range.
- `game.serverConfigSchema`: optional per-session settings consumed through `server.config`.
- `game.platforms`: tested device classes only.

Use `snack-configure-project` and the project-pinned `snack.schema.json` for the complete schema.
Publishing an already pushed version does not upload changed local assets; push a new version first.

## Authentication And Remote Targets

Saved credentials normally come from:

```sh
snack auth login
snack auth whoami
snack auth logout
```

`snack auth login --no-browser` prints the approval URL/code without opening a browser.
`snack auth login --token <token>` is for explicit automation/debugging; keep tokens out of logs and
shell history where possible.

Supported environment overrides:

- `SNACK_CONFIG_DIR`: credential/config directory
- `SNACK_API_URL`: API origin
- `SNACK_WORKSPACE_ID`: workspace target
- `SNACK_TOKEN`: bearer token
- `SNACK_GAME_ID`: explicit game target
- `SNACK_URL`: Snack web origin used by preview output

Remote commands accept `--api-url`, `--workspace-id`, `--token`, and `--game-id`.
`push` also accepts `--force-upload`, `publish` accepts `--message`, and `preview` accepts
`--snack-url`.

Use `--force-upload` only as an explicit repair for missing/corrupt storage objects, not as a normal
retry.

## Upload Limits

Current production preflight limits:

- at most 1024 files across server, client output, and assets
- at most 20 MiB per file
- at most 100 MiB of unique content-addressed blobs

Bundle code, pack/atlas large collections of tiny assets, compress media, and lazy-load non-critical
content. Publishable assets cannot be symlinks.

## Package-Local CLI

When `snack` is not global, use the installed project CLI:

```sh
npm exec -- snack auth whoami
pnpm exec snack auth whoami
bunx snack auth whoami
yarn snack auth whoami
```

Prefer package scripts for `check`, `build`, `push`, `versions`, `preview`, and `publish` because the
project owns orchestration.

## Troubleshooting

- Missing auth: run `snack auth whoami`, then login or verify saved/env credentials.
- Wrong workspace/game: inspect `whoami` and explicit workspace/game overrides.
- Missing version for publish: push first, use `snack versions`, or pass an explicit UUID.
- Preview genre error: set a valid `game.genre` in `snack.json` and rerun preview.
- Title image error: verify a safe relative path, file existence under `assets/`, and image MIME
  type.
- Asset/build failure: check symlinks, entrypoints, 1024-file count, 20 MiB per-file size, and
  100 MiB unique total.
- Missing `snack:client` or `snack:server` types: run the project build to regenerate `.snack/types`.
- Local connection failure: test through the Snack host shell, not Vite's client-only port.
