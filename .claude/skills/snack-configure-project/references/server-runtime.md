# Client, Server, And Shared Runtime Boundaries

## Sources Of Truth

Read these generated files before relying on exact APIs:

- `.snack/types/client.d.ts`
- `.snack/types/server.d.ts`

The project's pinned CLI version owns those declarations. Use architecture assumptions only to
interpret them, never to invent APIs absent from the types.

## Client Code

Client code runs in the browser iframe and may use normal browser libraries such as Canvas, WebGL,
WebGPU, Three.js, PixiJS, Phaser, React, or Solid.

Import:

```ts
import { client } from "snack:client";
```

Use:

- `client.launch`, `client.connection`, `client.ready`, and `client.closed`
- `client.net.rtt`, `latestRtt`, and `jitter`
- `client.datagrams` and `client.streams`
- `recv()`, `drain()`, `drainInto()`, async iteration, and `send()`

Do not fetch `/connect-info`, construct WebTransport, install callback-style receive plumbing, or
own the launch envelope with raw `postMessage`.

## Server Code

Server code runs in a restricted V8 isolate.

Import and export:

```ts
import { server } from "snack:server";

export async function main() {
  while (server.running) {
    const event = await server.datagrams.recv();
    // Validate event.json() before using it.
  }
}
```

The server owns authoritative gameplay and may use:

- the deeply frozen `server.config` snapshot
- trusted connection identity supplied by Snack
- connection views and RTT/jitter measurements
- datagram and reliable-stream queues
- targeted sends and broadcasts
- `server.sleep()`, `server.elapsedMs()`, and `server.end()`

`send()` and `broadcast()` validate and enqueue data for Snack, but do not acknowledge peer
delivery or processing. Build application acknowledgements, retries, and idempotency into the game
protocol when needed.

## Public Hosted Resource Limits

- A hosted game session has 250ms of CPU time per second. Sustained work above that budget is
  throttled and can delay simulation, message handling, and timers.
- Server JavaScript has a 512 MiB heap limit. Heap exhaustion terminates server execution.

Treat these as hard authoring constraints, not targets to fill. Keep work bounded per tick, message,
player, and entity. Cap queues, histories, caches, timers, retries, and catch-up steps, and clean them
up when players disconnect or rejoin. A successful local desktop run does not prove hosted CPU or
memory safety.

Browser code has no fixed Snack heap budget because devices and browsers differ. Measure client CPU,
GPU, and memory on every device class declared in `game.platforms`.

## Blocked Server Assumptions

Do not use or add dependencies that require:

- filesystem APIs
- `process`, environment variables, or subprocesses
- Node builtins or server listeners
- raw sockets, WebSocket servers, or WebTransport constructors
- native addons or postinstall-generated native binaries
- unmanaged workers
- outbound `fetch` unless Snack later exposes an explicit permission

Prefer pure JavaScript, browser-compatible packages, deterministic data structures where useful,
and bounded work. Use channel receives or `server.sleep()` to yield instead of busy loops.

## Shared Code

Keep `src/shared/` environment-neutral:

- discriminated message types and parsers
- constants and tuning values
- pure math and simulation helpers
- serialization helpers that use standard JavaScript APIs available in both environments

Do not import DOM/browser packages into shared files consumed by the server. Do not import
server-only authority or host capabilities into shared files consumed by the client.

## Diagnosing Compatibility Failures

1. Identify whether the failing import is client, server, or shared.
2. Trace transitive dependencies, package exports, and Node builtin use.
3. Move browser-only code out of the server graph.
4. Replace native/system packages with pure JavaScript alternatives.
5. Keep type, lint, and format diagnostics in project scripts; use Snack build/runtime diagnostics
   for platform compatibility.
6. Re-run the project `check` and `build` scripts.
