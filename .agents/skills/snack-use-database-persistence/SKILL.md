---
name: snack-use-database-persistence
description: Builds durable saved-game data with server.localDb, SQLite, Drizzle ORM, and generated schema migrations. Use for player progress, inventories, saved worlds, persistent chat, database schemas, migration generation, and persistence failures in a generated Snack.Game project; do not use for transient match state or Snack's platform database.
---

# Use Database Persistence

Build saved-game data on Snack's host-owned SQLite database. Prefer Drizzle ORM for schema and
queries, Drizzle Kit for migration generation, and a small Snack adapter at the database boundary.

## Inspect First

Read:

- `snack.json`
- `package.json`
- `.snack/types/server.d.ts`
- `src/server.ts`
- `src/db/schema.ts`, `drizzle.config.ts`, and `drizzle/` when present

Treat the project-pinned declarations as the exact API. Read
[references/persistence-api.md](references/persistence-api.md) before changing database behavior.

## Confirm The Data Lifetime

Persist data only when it must survive a game-server restart or continue in a saved game. Examples
include inventories, progress, worlds, match history, and persistent chat.

Keep round state, connection state, interpolation buffers, input queues, and short-lived caches in
memory. A saved-game database belongs to one saved game. It is not a global account database or a
replacement for Snack's control-plane services.

## Use The Drizzle Setup

Projects created with `snack new --persistence` or `snack init --persistence` already include:

- `server.persistence: true` in `snack.json`
- `drizzle-orm` and `drizzle-kit`
- `src/db/schema.ts` and the Snack synchronous SQLite adapter
- generated SQL under `drizzle/`
- a runtime-safe `src/db/migrations.ts` bundle
- `db:generate` and `db:check` package scripts

For an older project, generate a temporary reference project with the same installed Snack CLI and
`--persistence`, then copy only the database structure and merge its dependencies and scripts. Do
not run `snack init --persistence` inside a non-empty project or replace creator-owned game code.
Explicitly merge `server.persistence: true` into `snack.json`. When the project already has Drizzle
migrations, keep its history, change its schema, and generate the next migration instead of copying
the reference project's initial migration. `server.localDb` also works without the field, but that
database is session-local and disappears when the server exits. Do not rely on it for durable data.

Read [references/drizzle.md](references/drizzle.md) for the adapter, package scripts, generated-file
contract, and startup migration flow.

## Change The Schema

1. Change `src/db/schema.ts`.
2. Run `<package-manager> run db:generate`.
3. Review the new SQL. Check destructive changes and backfills explicitly.
4. Run `<package-manager> run db:check`.
5. Commit the schema, SQL migrations, Drizzle metadata, and `src/db/migrations.ts` together.
6. Apply pending migrations through `server.localDb` before loading durable gameplay state.

Never edit a migration that may already have run. Add a new forward migration. Keep migrations
idempotent at the application level by recording each applied migration in the database.

Enabling persistence cannot recover state from an earlier session-local database or from memory.
Start from defined defaults, backfill from a real trusted durable source, or design an explicit
handoff before the old process ends.

## Query Safely

- Derive player identity from trusted Snack connection data, not client payloads.
- Validate client-controlled values before writing them.
- Add unique constraints for idempotency keys and indexes for real query paths.
- Bound history, logs, snapshots, and per-player collections.
- Use Drizzle transactions or atomic `localDb.batch()` work for changes that must commit together.
- Keep Drizzle transaction callbacks synchronous. Do not `await` between explicit `BEGIN` and
  `COMMIT` calls.
- Keep database work out of latency-sensitive simulation steps.
- Do not import filesystem, native SQLite drivers, or Node database modules into server code.

## Verify

Run:

```sh
<package-manager> run db:generate
<package-manager> run db:check
<package-manager> run check
<package-manager> run build
```

Review the expected artifacts from the first `db:generate`. Run it again and confirm the second run
leaves no uncommitted migration changes. Test through the Snack host shell, write durable state,
restart `snack dev`, and confirm the state remains. Also create a fresh saved game and confirm
migrations build an empty database correctly.
