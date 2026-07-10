# Reliable Command, Bootstrap, And Revision Example

This example shows the core pattern for a turn-based “take stones” game. It bootstraps every new
connection, rejects stale state, and retries a command with the same id.

## Shared Messages

Use `type` aliases for every wire shape. Snack's recursive `NetworkMessage` accepts these structural
object types; an `interface` without an index signature does not satisfy the generated declaration.

```ts
// src/shared/messages.ts
export type PublicState = {
  revision: number;
  stones: number;
  activeUserId: string | null;
  winnerUserId: string | null;
};

export type TakeCommand = {
  v: 1;
  type: "take";
  commandId: string;
  expectedRevision: number;
  amount: 1 | 2 | 3;
};

export type BootstrapAck = { v: 1; type: "bootstrap-ack"; bootstrapId: string };

export type ServerMessage =
  | {
      v: 1;
      type: "state";
      commandId: string | null;
      bootstrapId: string | null;
      state: PublicState;
    }
  | {
      v: 1;
      type: "rejected";
      commandId: string;
      reason: "stale" | "not-your-turn" | "invalid";
      state: PublicState;
    };

export function parseTakeCommand(value: unknown): TakeCommand | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "take" ||
    typeof record.commandId !== "string" ||
    record.commandId.length < 1 ||
    record.commandId.length > 80 ||
    !Number.isSafeInteger(record.expectedRevision) ||
    (record.amount !== 1 && record.amount !== 2 && record.amount !== 3)
  ) {
    return undefined;
  }
  return record as unknown as TakeCommand;
}

export function parseBootstrapAck(value: unknown): BootstrapAck | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.type !== "bootstrap-ack" || typeof record.bootstrapId !== "string") {
    return undefined;
  }
  return { v: 1, type: "bootstrap-ack", bootstrapId: record.bootstrapId };
}

export function parseServerMessage(value: unknown): ServerMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const state = parseState(record.state);
  if (record.v !== 1 || !state) return undefined;

  if (
    record.type === "state" &&
    (typeof record.commandId === "string" || record.commandId === null) &&
    (typeof record.bootstrapId === "string" || record.bootstrapId === null)
  ) {
    return {
      v: 1,
      type: "state",
      commandId: record.commandId,
      bootstrapId: record.bootstrapId,
      state,
    };
  }
  if (
    record.type === "rejected" &&
    typeof record.commandId === "string" &&
    (record.reason === "stale" || record.reason === "not-your-turn" || record.reason === "invalid")
  ) {
    return {
      v: 1,
      type: "rejected",
      commandId: record.commandId,
      reason: record.reason,
      state,
    };
  }
  return undefined;
}

function parseState(value: unknown): PublicState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.revision) ||
    !Number.isSafeInteger(record.stones) ||
    (typeof record.activeUserId !== "string" && record.activeUserId !== null) ||
    (typeof record.winnerUserId !== "string" && record.winnerUserId !== null)
  ) {
    return undefined;
  }
  return record as unknown as PublicState;
}
```

## Authoritative Server

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  parseBootstrapAck,
  parseTakeCommand,
  type BootstrapAck,
  type PublicState,
  type ServerMessage,
  type TakeCommand,
} from "./shared/messages.js";

const state: PublicState = {
  revision: 0,
  stones: 15,
  activeUserId: null,
  winnerUserId: null,
};

const processed = new Map<string, ServerMessage>();
type PendingBootstrap = {
  message: Extract<ServerMessage, { type: "state" }>;
  lastSentAtMs: number;
  attempts: number;
  acknowledged: boolean;
};
const pendingBootstraps = new Map<string, PendingBootstrap>();
const BOOTSTRAP_RETRY_MS = 500;
const MAX_BOOTSTRAP_ATTEMPTS = 20;
let nextBootstrapId = 0;

export async function main(): Promise<void> {
  while (server.running) {
    pruneDisconnectedConnections();
    sendBootstraps();
    const activePlayerChanged = ensureActivePlayer();
    if (activePlayerChanged) broadcastStateToReady(stateMessage(null));

    for (const event of server.streams.drain()) {
      const value = safeJson(event);
      const ack = parseBootstrapAck(value);
      if (ack) {
        acknowledgeBootstrap(event.connection.id, ack);
        continue;
      }
      const command = parseTakeCommand(value);
      if (!command) continue;
      if (!pendingBootstraps.get(event.connection.id)?.acknowledged) continue;
      handleCommand(event.connection, command);
    }

    await server.sleep(16);
  }
}

function handleCommand(connection: Connection, command: TakeCommand): void {
  // This game gives one seat to each user. Two connections for one user share that seat.
  const dedupeKey = `${connection.userId}:${command.commandId}`;
  const cached = processed.get(dedupeKey);
  if (cached) {
    connection.streams.send(cached);
    return;
  }

  const result = applyCommand(connection.userId, command);
  remember(dedupeKey, result);
  if (result.type === "state") {
    broadcastStateToReady(result);
  } else {
    connection.streams.send(result);
  }
}

function applyCommand(userId: string, command: TakeCommand): ServerMessage {
  if (command.expectedRevision !== state.revision) return reject(command, "stale");
  if (state.activeUserId !== userId) return reject(command, "not-your-turn");
  if (state.winnerUserId || command.amount > state.stones) return reject(command, "invalid");

  state.stones -= command.amount;
  state.revision += 1;
  if (state.stones === 0) {
    state.winnerUserId = userId;
  } else {
    state.activeUserId = nextConnectedUser(userId);
  }
  return stateMessage(command.commandId);
}

function reject(
  command: TakeCommand,
  reason: "stale" | "not-your-turn" | "invalid",
): ServerMessage {
  return {
    v: 1,
    type: "rejected",
    commandId: command.commandId,
    reason,
    state: { ...state },
  };
}

function stateMessage(commandId: string | null): Extract<ServerMessage, { type: "state" }> {
  return { v: 1, type: "state", commandId, bootstrapId: null, state: { ...state } };
}

function sendBootstraps(): void {
  const nowMs = server.elapsedMs();
  for (const connection of server.connections) {
    let pending = pendingBootstraps.get(connection.id);
    if (!pending) {
      pending = {
        message: {
          ...stateMessage(null),
          bootstrapId: `${connection.id}:${nextBootstrapId++}`,
        },
        lastSentAtMs: -Infinity,
        attempts: 0,
        acknowledged: false,
      };
      pendingBootstraps.set(connection.id, pending);
    }
    if (
      pending.acknowledged ||
      pending.attempts >= MAX_BOOTSTRAP_ATTEMPTS ||
      nowMs - pending.lastSentAtMs < BOOTSTRAP_RETRY_MS
    ) {
      continue;
    }
    connection.streams.send(pending.message);
    pending.lastSentAtMs = nowMs;
    pending.attempts += 1;
  }
}

function acknowledgeBootstrap(connectionId: string, ack: BootstrapAck): void {
  const pending = pendingBootstraps.get(connectionId);
  if (pending?.message.bootstrapId === ack.bootstrapId) pending.acknowledged = true;
}

function pruneDisconnectedConnections(): void {
  const connected = new Set(server.connections.map((connection) => connection.id));
  for (const connectionId of pendingBootstraps.keys()) {
    if (!connected.has(connectionId)) pendingBootstraps.delete(connectionId);
  }
}

function ensureActivePlayer(): boolean {
  const users = connectedUsers();
  if (state.activeUserId && users.includes(state.activeUserId)) return false;
  const next = users[0] ?? null;
  if (next === state.activeUserId) return false;
  state.activeUserId = next;
  state.revision += 1;
  return true;
}

function nextConnectedUser(currentUserId: string): string {
  const users = connectedUsers();
  if (users.length === 0) return currentUserId;
  const currentIndex = users.indexOf(currentUserId);
  return users[(currentIndex + 1) % users.length] ?? currentUserId;
}

function connectedUsers(): string[] {
  return [
    ...new Set(
      server.connections
        .filter((connection) => pendingBootstraps.get(connection.id)?.acknowledged)
        .map((connection) => connection.userId),
    ),
  ].sort();
}

function broadcastStateToReady(message: Extract<ServerMessage, { type: "state" }>): void {
  const readyConnectionIds = server.connections
    .filter((connection) => pendingBootstraps.get(connection.id)?.acknowledged)
    .map((connection) => connection.id);
  if (readyConnectionIds.length > 0) {
    server.streams.broadcast(message, { only: readyConnectionIds });
  }
}

function remember(key: string, result: ServerMessage): void {
  processed.set(key, result);
  if (processed.size > 1024) {
    const oldest = processed.keys().next().value;
    if (typeof oldest === "string") processed.delete(oldest);
  }
}

function safeJson(event: { json(): unknown }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
}
```

## Client Command, Retry, And Receive Loop

```ts
// src/client.ts
import { client } from "snack:client";
import {
  parseServerMessage,
  type BootstrapAck,
  type PublicState,
  type TakeCommand,
} from "./shared/messages.js";

type PendingCommand = {
  command: TakeCommand;
  attempts: number;
  lastSentAt: number;
};

const RETRY_AFTER_MS = 1500;
const MAX_ATTEMPTS = 3;
let state: PublicState | undefined;
const pending = new Map<string, PendingCommand>();

export async function take(amount: 1 | 2 | 3): Promise<void> {
  if (!state) return;
  const command: TakeCommand = {
    v: 1,
    type: "take",
    commandId: crypto.randomUUID(),
    expectedRevision: state.revision,
    amount,
  };
  pending.set(command.commandId, { command, attempts: 1, lastSentAt: performance.now() });
  await client.streams.send(command);
}

async function retryPending(): Promise<void> {
  const now = performance.now();
  for (const pendingCommand of pending.values()) {
    if (now - pendingCommand.lastSentAt < RETRY_AFTER_MS) continue;
    if (pendingCommand.attempts >= MAX_ATTEMPTS) {
      pending.delete(pendingCommand.command.commandId);
      render(state, "command-timeout");
      continue;
    }
    pendingCommand.attempts += 1;
    pendingCommand.lastSentAt = now;
    await client.streams.send(pendingCommand.command);
  }
}

async function receive(): Promise<void> {
  for await (const event of client.streams) {
    const message = parseServerMessage(safeJson(event));
    if (!message) continue;
    if (message.commandId) pending.delete(message.commandId);
    if (message.type === "state" && message.bootstrapId) {
      const ack: BootstrapAck = {
        v: 1,
        type: "bootstrap-ack",
        bootstrapId: message.bootstrapId,
      };
      await client.streams.send(ack);
    }

    // Separate reliable messages can complete out of order. Never move state backward.
    if (state && message.state.revision < state.revision) continue;
    state = message.state;
    render(state, message.type === "rejected" ? message.reason : undefined);
  }
}

function render(next: PublicState | undefined, error?: string): void {
  console.log({ next, error });
}

function safeJson(event: { json(): unknown }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
}

window.setInterval(() => void retryPending().catch(console.error), 250);
void receive();
```

The initial reliable state removes the startup deadlock. Retrying sends the exact same command and
`commandId`; the bounded server cache prevents double application.
