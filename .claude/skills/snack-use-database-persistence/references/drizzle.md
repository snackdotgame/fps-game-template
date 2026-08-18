# Drizzle ORM And Migrations

## Recommendation

Use the scaffold's synchronous Drizzle adapter. It combines Drizzle's synchronous SQLite session
with `server.localDb`, so schema and query types stay in the project while all SQL execution stays
behind the Snack capability. Use Drizzle Kit to generate SQL migrations from `src/db/schema.ts`.

Do not import `better-sqlite3`, `node:sqlite`, or Drizzle's filesystem migrator into server code.
Those need authority that the Snack runtime does not expose.

## Project Shape

The persistence scaffold uses:

```txt
drizzle.config.ts
drizzle/
  0000_*.sql
  meta/
scripts/
  generate-migrations.mjs
src/db/
  adapter.ts
  client.ts
  migrate.ts
  migrations.ts
  schema.ts
```

`drizzle.config.ts` points to `src/db/schema.ts` and writes SQL plus metadata to `drizzle/`.
`scripts/generate-migrations.mjs` converts that filesystem-owned development output into a typed
`src/db/migrations.ts` array. Only the typed array enters the restricted server bundle.

## Package Scripts

Keep these project-owned scripts:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate && node scripts/generate-migrations.mjs && oxfmt --write src/db/migrations.ts",
    "db:check": "drizzle-kit check"
  }
}
```

`db:generate` creates a new SQL migration when the schema changes, then always refreshes the
runtime-safe bundle. `db:check` validates the migration history. There is no local `db:migrate`
script: each saved-game database is available only through `server.localDb`, and the server applies
pending migrations during startup. Drizzle Kit and the migration bundling script run in Node during
development; they are never imported by the hosted server bundle.

## Adapter Boundary

Create Drizzle through the scaffolded client:

```ts
const db = createDatabase(server.localDb);
```

The adapter maps Drizzle's synchronous `get`, `all`, and `run` methods to the matching
`LocalDatabase` statement methods. Its transaction wrapper sends `BEGIN`, runs the synchronous
callback, and then sends `COMMIT` or `ROLLBACK`. Keep the one driver compatibility cast inside the
client; do not spread it through game code.

Do not make a Drizzle transaction callback `async`. `server.localDb` calls return direct values,
but JavaScript still yields when a non-promise is passed to `await`. Any yield between `BEGIN` and
`COMMIT` breaks the uninterrupted transaction sequence.

Drizzle's SQLite BLOB mapper may require browser-style `Buffer` compatibility in versions where a
schema uses BLOB columns. Add that narrow pure-JavaScript conversion only when the schema needs it.
Do not add a broad Node polyfill.

## Startup Migrations

Run migrations before reading durable state:

```ts
export async function main() {
  applyMigrations(server.localDb, migrations);
  const db = createDatabase(server.localDb);
  // Load durable game state, then start gameplay.
}
```

The migration helper creates an internal migration table, verifies the applied id and hash prefix,
and applies each later migration plus its record in one transaction. Migration ids come from the
Drizzle journal and hashes come from the generated SQL. For a Drizzle SQLite table rebuild, the
generator records the foreign-key toggle so the runner can disable enforcement before starting the
transaction, run `foreign_key_check`, commit, and restore enforcement. A mismatch or constraint
violation stops startup instead of silently running a divergent schema.

Do not edit old SQL or its journal entry after release. Change the schema, generate the next
migration, inspect its SQL, and add explicit data movement when a column or constraint cannot be
changed safely in one step.

## Schema And Query Guidance

- Use integer primary keys for local rows unless the game already owns a stable string id.
- Use trusted Snack user ids for player ownership, with an index or unique key that matches the
  lookup.
- Prefer normalized authoritative data over large JSON blobs when fields are queried or updated
  independently.
- Use a BLOB for compact opaque snapshots only when the game can version and validate the encoding.
- Keep generated migrations in source control. A schema file alone cannot upgrade existing saves.
- Drizzle transactions use the same SQLite connection. Keep their callbacks synchronous.
