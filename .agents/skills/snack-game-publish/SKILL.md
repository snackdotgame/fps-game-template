---
name: snack-game-publish
description: Prepare, authenticate, push, list, preview, and publish generated Snack.Game projects. Use when the user asks to release or host a game, create an immutable pushed version, launch an unlisted preview, make a version public, or troubleshoot Snack CLI authentication and remote publishing.
---

# Publish A Snack.Game Project

Use this workflow only for generated Snack.Game projects. Push, preview, and publish change remote
state; execute them only when the user explicitly requests the corresponding action.

## Inspect The Project

Read:

- `AGENTS.md`
- `snack.json`
- `package.json`
- `src/client.ts`, `src/server.ts`, and relevant `src/shared/*`

Detect the package manager from `package.json.packageManager` and use its project scripts. Direct
`snack` commands are valid when the project-local or installed CLI is on `PATH`.

If general manifest, entrypoint, room-config, platform, or runtime changes are needed, use
`snack-configure-project` before continuing. Read
[references/publish-reference.md](references/publish-reference.md) for exact metadata, flags,
limits, and troubleshooting.

## Confirm The Requested Remote Action

Distinguish:

- `push`: build and upload a new immutable version; do not launch it or make it public
- `versions`: inspect already pushed versions
- `preview`: launch an unlisted server from a pushed version
- `publish`: make a pushed version the public live version

Do not substitute publish for preview, or imply that push made a version live.

## Preflight

Check:

- `@snack-game/cli` is a project dev dependency
- client/server entrypoints and `assets/` still match the scaffold
- `game.maxPlayers` matches intended room capacity
- `game.titleImage` points to an image under `assets/`
- `game.genre` is set before previewing
- `game.platforms` claims only tested device classes
- publishable assets are regular files rather than symlinks

Run:

```sh
<package-manager> run check
<package-manager> run build
```

Stop on failures. Do not upload a build that does not pass the project's gates unless the user
explicitly narrows the task and accepts the risk.

## Authenticate

Check the active account and workspace:

```sh
snack auth whoami
```

When a global binary is unavailable, run the project-local CLI through the package manager. If
credentials are missing and the user wants to continue, run:

```sh
snack auth login
```

Use `snack auth login --no-browser` for a remote terminal. Never print, log, or commit CLI tokens.

## Push

Create a new immutable version:

```sh
<package-manager> run push
```

Capture the printed version id. `snack push` writes the finalized id to `game.versionId` when the
configured game identity permits it. It does not publish or launch the version.

List versions when selecting or verifying an id:

```sh
<package-manager> run versions
```

## Preview

Launch an unlisted server from the latest ready pushed version:

```sh
<package-manager> run preview
```

Launch a specific pushed version:

```sh
<package-manager> run preview -- <version-id>
```

Capture and report the preview URL and version id. Never describe an unlisted preview as private.

## Publish

Publishing is a deliberate public action. Use the version stored in `game.versionId`:

```sh
<package-manager> run publish
```

Or publish an explicitly selected pushed version:

```sh
<package-manager> run publish -- <version-id>
```

Report the published version id and public URL/output. Do not claim success until the command
returns successfully.

## Finish

Summarize:

- account/workspace used without exposing credentials
- preflight commands and results
- pushed version number/name/id, when applicable
- preview URL and access semantics, when applicable
- published version and public result, when applicable
- any manifest change written back by the CLI
