# Snack Persistence API

## Durability

The creator opts in per immutable game version:

```json
{
  "server": {
    "entry": "src/server.ts",
    "persistence": true
  }
}
```

`server.localDb` is always available. The manifest field controls durability, not API access. When
`persistence` is false or missing, Snack creates a session-local database and discards it when the
game server exits. No saved game, storage credential, or S3 replica is created. Use this mode for
temporary server-local data only.

With persistence enabled, local development stores the default saved-game database at
`.snack/dev/saved-games/default/state.db` and keeps it across `snack dev` restarts. Without it,
`snack dev` uses a temporary database for that CLI process. Hosted databases for kept saved games
survive the game-server process that used them. Guest or quota-full play of a persistence-enabled
game can still use a session-local database without creating a save. The database limit is 200 MiB.
If durable bootstrap fails because of authentication, control-plane, or storage errors, the
operation fails with `UNAVAILABLE` and the session stops. Snack does not silently turn an eligible
durable run into session-local storage.

## Runtime Shape

`server.localDb` is synchronous and host-owned. Its JavaScript semantics match Deno's synchronous
`node:sqlite` API. It exposes:

- `prepare<Row>(sql)` for reusable statements
- `exec(sql)` to pass a fixed SQL script directly to SQLite
- `batch(statements, options?)` for parameterized atomic work

Prepared statements provide `get`, `all`, `getValues`, `values`, and `run`. Bound and returned
values are `null`, strings, numbers, bigints, and byte arrays. Use bigint reading only when SQLite
integers may exceed JavaScript's safe integer range.

The runtime does not expose a database path, filesystem access, raw native handle, extension
loading, or native SQLite package. Each database call blocks the current creator task until SQLite
finishes. Keep database work out of the main simulation loop.

## Atomicity And Errors

Use `batch()` when several parameterized statements must commit or roll back together. It adds its
own transaction and throws `INVALID_SQL` for transaction-control statements inside the batch. `exec()` matches
Deno's `node:sqlite`: it sends the script to SQLite as supplied and does not add a transaction.
Scripts can include `BEGIN`, `COMMIT`, `ROLLBACK`, savepoints, and connection PRAGMAs that Snack
does not reserve for host safety.

Prepared statements can also issue transaction-control SQL. Because database methods are
synchronous, code can run `BEGIN`, statements, and `COMMIT` without another creator task entering
the connection between those calls. Do not `await` or perform other asynchronous work inside an
explicit transaction. Database methods do not return promises. JavaScript allows `await` on a
non-promise value, but doing that still yields after the synchronous call has completed.

Failures throw a `DatabaseError` synchronously. Handle a stable `error.code` only when the game has a real
recovery path. Let startup migration failures stop startup instead of running against a partial or
unknown schema.

## Data Design

- Use a trusted `connection.userId` as the player key when data is player-scoped.
- Add a game-owned idempotency key for retryable rewards, purchases, or commands.
- Put uniqueness and relationship rules in SQLite constraints as well as server validation.
- Store compact authoritative state. Do not use the database as an unbounded event log.
- Add indexes only for measured lookup and ordering paths; each index also costs write work and
  storage.
- Load the durable state needed for play at startup, keep the active working set in memory, and
  persist at explicit checkpoints.
