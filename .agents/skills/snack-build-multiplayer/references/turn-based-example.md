# Reliable Command, Bootstrap, And Revision Example

This example shows the core pattern for a turn-based “take stones” game. It bootstraps every new
connection, rejects stale state, and retries a command with the same id.

## Shared Messages

Gameplay messages are binary from the first implementation. Each packet starts with a `version:
uint8` then a `kind: uint8` tag and is little-endian throughout; the logical decoded shapes stay
`type` aliases so downstream code keeps reading `message.type`. Local encoders throw on invalid
local state before a send; remote decoders validate every field and return `undefined` instead of
throwing. Command and bootstrap ids are `uint32` counters (`0` is the on-wire “none”); the userId
strings ride the reliable stream length-prefixed with a hard cap. Numeric counter ids are only
unique within one client runtime, so each take also carries a per-runtime `clientNonce` that scopes
those ids across other players and fresh-launch rejoins while keeping dedupe keyed by the logical
player.

```ts
// src/shared/messages.ts
//
// Binary wire protocol. Every packet is `version: uint8` then `kind: uint8`,
// little-endian throughout. The logical decoded shapes stay `type` aliases and
// live beside their codecs so the encode and decode paths cannot drift apart.

export type PublicState = {
  revision: number;
  stones: number;
  activeUserId: string | null;
  winnerUserId: string | null;
};

export type TakeCommand = {
  v: 1;
  type: "take";
  commandId: number;
  clientNonce: number;
  expectedRevision: number;
  amount: 1 | 2 | 3;
};

export type BootstrapAck = { v: 1; type: "bootstrap-ack"; bootstrapId: number };

export type ServerMessage =
  | {
      v: 1;
      type: "state";
      commandId: number | null;
      commandNonce: number;
      bootstrapId: number | null;
      state: PublicState;
    }
  | {
      v: 1;
      type: "rejected";
      commandId: number;
      commandNonce: number;
      reason: "stale" | "not-your-turn" | "invalid";
      state: PublicState;
    };

const PROTOCOL_VERSION = 1;

// Stable numeric message tags. Never reorder; append only.
const KIND_TAKE = 1;
const KIND_BOOTSTRAP_ACK = 2;
const KIND_STATE = 3;
const KIND_REJECTED = 4;

// Reason enum tags for a rejected command.
const REASON_STALE = 1;
const REASON_NOT_YOUR_TURN = 2;
const REASON_INVALID = 3;

const AMOUNT_MIN = 1;
const AMOUNT_MAX = 3;

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;

// userId strings ride the reliable stream, length-prefixed with a hard cap.
// 0xff marks "absent" so a present empty string stays distinct from null.
const USER_ID_MAX = 64;
const STRING_ABSENT = 0xff;

// commandId and bootstrapId are uint32 counters; 0 is the on-wire "none", so a
// real id is always >= 1 and never collides with the sentinel. A counter id is
// only unique within one client runtime, so a take also carries clientNonce (a
// uint32 drawn once per runtime); the server dedupes by userId+nonce+commandId
// and echoes commandNonce so an id scopes across other players and fresh-launch
// rejoins while dedupe stays keyed by logical player. commandNonce is 0 exactly
// when commandId is the null sentinel.
const COUNTER_NONE = 0;

// Fixed byte layouts (variable state is appended after the header).
const TAKE_BYTES = 15; // ver u8, kind u8, commandId u32, clientNonce u32, expectedRevision u32, amount u8
const BOOTSTRAP_ACK_BYTES = 6; // ver u8, kind u8, bootstrapId u32
const STATE_HEADER_BYTES = 14; // ver u8, kind u8, commandId u32, commandNonce u32, bootstrapId u32
const REJECTED_HEADER_BYTES = 11; // ver u8, kind u8, commandId u32, commandNonce u32, reason u8

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeTakeCommand(message: TakeCommand): Uint8Array {
  if (
    !isUint32(message.commandId) ||
    message.commandId < 1 ||
    !isUint32(message.clientNonce) ||
    message.clientNonce < 1 ||
    !isUint32(message.expectedRevision) ||
    (message.amount !== 1 && message.amount !== 2 && message.amount !== 3)
  ) {
    throw new Error("Invalid local take command");
  }
  const bytes = new Uint8Array(TAKE_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_TAKE);
  view.setUint32(2, message.commandId, true);
  view.setUint32(6, message.clientNonce, true);
  view.setUint32(10, message.expectedRevision, true);
  view.setUint8(14, message.amount);
  return bytes;
}

export function decodeTakeCommand(bytes: Uint8Array): TakeCommand | undefined {
  if (bytes.byteLength !== TAKE_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_TAKE) {
    return undefined;
  }
  const commandId = view.getUint32(2, true);
  const clientNonce = view.getUint32(6, true);
  const expectedRevision = view.getUint32(10, true);
  const amount = view.getUint8(14);
  if (commandId < 1 || clientNonce < 1 || amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
    return undefined;
  }
  return {
    v: 1,
    type: "take",
    commandId,
    clientNonce,
    expectedRevision,
    amount: amount as 1 | 2 | 3,
  };
}

export function encodeBootstrapAck(message: BootstrapAck): Uint8Array {
  if (!isUint32(message.bootstrapId) || message.bootstrapId < 1) {
    throw new Error("Invalid local bootstrap ack");
  }
  const bytes = new Uint8Array(BOOTSTRAP_ACK_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_BOOTSTRAP_ACK);
  view.setUint32(2, message.bootstrapId, true);
  return bytes;
}

export function decodeBootstrapAck(bytes: Uint8Array): BootstrapAck | undefined {
  if (bytes.byteLength !== BOOTSTRAP_ACK_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_BOOTSTRAP_ACK) {
    return undefined;
  }
  const bootstrapId = view.getUint32(2, true);
  if (bootstrapId < 1) return undefined;
  return { v: 1, type: "bootstrap-ack", bootstrapId };
}

export function encodeServerMessage(message: ServerMessage): Uint8Array {
  const active = encodeUserId(message.state.activeUserId);
  const winner = encodeUserId(message.state.winnerUserId);
  if (message.type === "state") {
    const bytes = new Uint8Array(STATE_HEADER_BYTES + stateByteLength(active, winner));
    const view = new DataView(bytes.buffer);
    view.setUint8(0, PROTOCOL_VERSION);
    view.setUint8(1, KIND_STATE);
    view.setUint32(2, encodeCounter(message.commandId), true);
    view.setUint32(6, encodeCommandNonce(message.commandId, message.commandNonce), true);
    view.setUint32(10, encodeCounter(message.bootstrapId), true);
    writeState(view, STATE_HEADER_BYTES, message.state, active, winner);
    return bytes;
  }
  const bytes = new Uint8Array(REJECTED_HEADER_BYTES + stateByteLength(active, winner));
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_REJECTED);
  view.setUint32(2, encodeCounter(message.commandId), true);
  view.setUint32(6, encodeCommandNonce(message.commandId, message.commandNonce), true);
  view.setUint8(10, reasonTag(message.reason));
  writeState(view, REJECTED_HEADER_BYTES, message.state, active, winner);
  return bytes;
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage | undefined {
  if (bytes.byteLength < 2) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION) return undefined;
  const kind = view.getUint8(1);

  if (kind === KIND_STATE) {
    if (bytes.byteLength < STATE_HEADER_BYTES) return undefined;
    const commandIdRaw = view.getUint32(2, true);
    const commandNonceRaw = view.getUint32(6, true);
    const bootstrapIdRaw = view.getUint32(10, true);
    // commandNonce is 0 exactly when commandId is the null sentinel; reject any
    // packet where only one of the pair is the sentinel.
    if ((commandIdRaw === COUNTER_NONE) !== (commandNonceRaw === COUNTER_NONE)) {
      return undefined;
    }
    const decoded = decodeState(view, STATE_HEADER_BYTES);
    if (!decoded || decoded.offset !== bytes.byteLength) return undefined;
    return {
      v: 1,
      type: "state",
      commandId: commandIdRaw === COUNTER_NONE ? null : commandIdRaw,
      commandNonce: commandNonceRaw,
      bootstrapId: bootstrapIdRaw === COUNTER_NONE ? null : bootstrapIdRaw,
      state: decoded.state,
    };
  }

  if (kind === KIND_REJECTED) {
    if (bytes.byteLength < REJECTED_HEADER_BYTES) return undefined;
    const commandId = view.getUint32(2, true);
    const commandNonce = view.getUint32(6, true);
    const reason = decodeReason(view.getUint8(10));
    const decoded = decodeState(view, REJECTED_HEADER_BYTES);
    // A rejected command always names a real command, so both ids are non-zero.
    if (
      commandId < 1 ||
      commandNonce < 1 ||
      !reason ||
      !decoded ||
      decoded.offset !== bytes.byteLength
    ) {
      return undefined;
    }
    return { v: 1, type: "rejected", commandId, commandNonce, reason, state: decoded.state };
  }

  return undefined;
}

// One compact formatter for the highest-rate family (broadcast state/rejected).
export function formatServerMessageForLog(bytes: Uint8Array): string {
  const message = decodeServerMessage(bytes);
  if (!message) return `invalid server packet (${bytes.byteLength} bytes)`;
  const s = message.state;
  const active = s.activeUserId ?? "-";
  const winner = s.winnerUserId ?? "-";
  if (message.type === "state") {
    return `state rev=${s.revision} stones=${s.stones} active=${active} winner=${winner} cmd=${message.commandId ?? "-"} boot=${message.bootstrapId ?? "-"}`;
  }
  return `rejected rev=${s.revision} reason=${message.reason} cmd=${message.commandId}`;
}

function writeState(
  view: DataView,
  offset: number,
  state: PublicState,
  active: Uint8Array | null,
  winner: Uint8Array | null,
): number {
  if (!isUint32(state.revision)) throw new Error("Invalid revision");
  if (!Number.isInteger(state.stones) || state.stones < 0 || state.stones > UINT16_MAX) {
    throw new Error("Invalid stones count");
  }
  view.setUint32(offset, state.revision, true);
  offset += 4;
  view.setUint16(offset, state.stones, true);
  offset += 2;
  offset = writeOptionalString(view, offset, active);
  offset = writeOptionalString(view, offset, winner);
  return offset;
}

function decodeState(
  view: DataView,
  offset: number,
): { state: PublicState; offset: number } | undefined {
  const end = view.byteLength;
  if (offset + 6 > end) return undefined;
  const revision = view.getUint32(offset, true);
  offset += 4;
  const stones = view.getUint16(offset, true);
  offset += 2;
  const active = readOptionalString(view, offset);
  if (!active) return undefined;
  const winner = readOptionalString(view, active.offset);
  if (!winner) return undefined;
  return {
    state: { revision, stones, activeUserId: active.value, winnerUserId: winner.value },
    offset: winner.offset,
  };
}

function writeOptionalString(view: DataView, offset: number, bytes: Uint8Array | null): number {
  if (bytes === null) {
    view.setUint8(offset, STRING_ABSENT);
    return offset + 1;
  }
  view.setUint8(offset, bytes.byteLength);
  new Uint8Array(view.buffer, view.byteOffset + offset + 1, bytes.byteLength).set(bytes);
  return offset + 1 + bytes.byteLength;
}

function readOptionalString(
  view: DataView,
  offset: number,
): { value: string | null; offset: number } | undefined {
  const end = view.byteLength;
  if (offset + 1 > end) return undefined;
  const lenByte = view.getUint8(offset);
  offset += 1;
  if (lenByte === STRING_ABSENT) return { value: null, offset };
  if (lenByte > USER_ID_MAX) return undefined; // reject over-cap length before reading
  if (offset + lenByte > end) return undefined;
  const slice = new Uint8Array(view.buffer, view.byteOffset + offset, lenByte);
  let value: string;
  try {
    value = textDecoder.decode(slice); // fatal decoder rejects invalid UTF-8
  } catch {
    return undefined;
  }
  return { value, offset: offset + lenByte };
}

function encodeUserId(value: string | null): Uint8Array | null {
  if (value === null) return null;
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength > USER_ID_MAX) throw new Error("userId exceeds wire cap");
  return bytes;
}

function stateByteLength(active: Uint8Array | null, winner: Uint8Array | null): number {
  return 4 + 2 + optionalStringBytes(active) + optionalStringBytes(winner);
}

function optionalStringBytes(bytes: Uint8Array | null): number {
  return bytes === null ? 1 : 1 + bytes.byteLength;
}

function encodeCounter(value: number | null): number {
  if (value === null) return COUNTER_NONE;
  if (!isUint32(value) || value < 1) throw new Error("Invalid counter id");
  return value;
}

// commandNonce pairs with commandId: it is 0 exactly when commandId is null,
// and a real uint32 nonce (>= 1) whenever a command is named.
function encodeCommandNonce(commandId: number | null, commandNonce: number): number {
  if (commandId === null) {
    if (commandNonce !== COUNTER_NONE)
      throw new Error("commandNonce must be 0 without a commandId");
    return COUNTER_NONE;
  }
  if (!isUint32(commandNonce) || commandNonce < 1) throw new Error("Invalid command nonce");
  return commandNonce;
}

function reasonTag(reason: "stale" | "not-your-turn" | "invalid"): number {
  switch (reason) {
    case "stale":
      return REASON_STALE;
    case "not-your-turn":
      return REASON_NOT_YOUR_TURN;
    case "invalid":
      return REASON_INVALID;
  }
}

function decodeReason(tag: number): "stale" | "not-your-turn" | "invalid" | undefined {
  switch (tag) {
    case REASON_STALE:
      return "stale";
    case REASON_NOT_YOUR_TURN:
      return "not-your-turn";
    case REASON_INVALID:
      return "invalid";
    default:
      return undefined;
  }
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}
```

## Authoritative Server

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  decodeBootstrapAck,
  decodeTakeCommand,
  encodeServerMessage,
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
const retiredConnectionIds = new Set<string>();
const BOOTSTRAP_RETRY_MS = 500;
const MAX_BOOTSTRAP_ATTEMPTS = 20;
let nextBootstrapId = 1; // 0 is the on-wire "none"; real bootstrap ids start at 1

export async function main(): Promise<void> {
  while (server.running) {
    pruneDisconnectedConnections();
    sendBootstraps();
    const activePlayerChanged = ensureActivePlayer();
    if (activePlayerChanged) broadcastStateToReady(stateMessage(null, 0));

    for (const event of server.streams.drain()) {
      if (retiredConnectionIds.has(event.connection.id)) continue;
      const ack = decodeBootstrapAck(event.bytes);
      if (ack) {
        acknowledgeBootstrap(event.connection.id, ack);
        continue;
      }
      const command = decodeTakeCommand(event.bytes);
      if (!command) continue;
      if (!pendingBootstraps.get(event.connection.id)?.acknowledged) continue;
      handleCommand(event.connection, command);
    }

    await server.sleep(16);
  }
}

function handleCommand(connection: Connection, command: TakeCommand): void {
  // This game gives one seat to each user. Two connections for one user share that seat.
  // The clientNonce scopes the counter to one client runtime, so a fresh launch of the
  // same signed-in user (its counter restarts at 1) cannot collide with cached entries.
  const dedupeKey = `${connection.userId}:${command.clientNonce}:${command.commandId}`;
  const cached = processed.get(dedupeKey);
  if (cached) {
    connection.streams.send(encodeServerMessage(cached));
    return;
  }

  const result = applyCommand(connection.userId, command);
  remember(dedupeKey, result);
  if (result.type === "state") {
    broadcastStateToReady(result);
  } else {
    connection.streams.send(encodeServerMessage(result));
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
  return stateMessage(command.commandId, command.clientNonce);
}

function reject(
  command: TakeCommand,
  reason: "stale" | "not-your-turn" | "invalid",
): ServerMessage {
  return {
    v: 1,
    type: "rejected",
    commandId: command.commandId,
    commandNonce: command.clientNonce,
    reason,
    state: { ...state },
  };
}

function stateMessage(
  commandId: number | null,
  commandNonce: number,
): Extract<ServerMessage, { type: "state" }> {
  return { v: 1, type: "state", commandId, commandNonce, bootstrapId: null, state: { ...state } };
}

function sendBootstraps(): void {
  const nowMs = server.elapsedMs();
  for (const connection of server.connections) {
    if (retiredConnectionIds.has(connection.id)) continue;
    let pending = pendingBootstraps.get(connection.id);
    if (!pending) {
      pending = {
        message: {
          ...stateMessage(null, 0),
          bootstrapId: nextBootstrapId++,
        },
        lastSentAtMs: -Infinity,
        attempts: 0,
        acknowledged: false,
      };
      pendingBootstraps.set(connection.id, pending);
    }
    if (pending.acknowledged) continue;
    if (pending.attempts >= MAX_BOOTSTRAP_ATTEMPTS) {
      pendingBootstraps.delete(connection.id);
      retiredConnectionIds.add(connection.id);
      continue;
    }
    if (nowMs - pending.lastSentAtMs < BOOTSTRAP_RETRY_MS) continue;
    connection.streams.send(encodeServerMessage(pending.message));
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
  for (const connectionId of retiredConnectionIds) {
    if (!connected.has(connectionId)) retiredConnectionIds.delete(connectionId);
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
        .filter((connection) => !retiredConnectionIds.has(connection.id))
        .filter((connection) => pendingBootstraps.get(connection.id)?.acknowledged)
        .map((connection) => connection.userId),
    ),
  ].sort();
}

function broadcastStateToReady(message: Extract<ServerMessage, { type: "state" }>): void {
  const readyConnectionIds = server.connections
    .filter((connection) => !retiredConnectionIds.has(connection.id))
    .filter((connection) => pendingBootstraps.get(connection.id)?.acknowledged)
    .map((connection) => connection.id);
  if (readyConnectionIds.length > 0) {
    server.streams.broadcast(encodeServerMessage(message), { only: readyConnectionIds });
  }
}

function remember(key: string, result: ServerMessage): void {
  processed.set(key, result);
  if (processed.size > 1024) {
    const oldest = processed.keys().next().value;
    if (typeof oldest === "string") processed.delete(oldest);
  }
}
```

## Client Command, Retry, And Receive Loop

```ts
// src/client.ts
import { client } from "snack:client";
import {
  decodeServerMessage,
  encodeBootstrapAck,
  encodeTakeCommand,
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
const pending = new Map<number, PendingCommand>();
let nextCommandId = 1; // per-client uint32 counter; 0 is the on-wire "none"
// Counter ids only stay unique within one client runtime. Draw a random uint32
// once so the server can scope this runtime's ids apart from other players and
// from a fresh launch of this same signed-in user (whose counter restarts at 1).
const clientNonce = crypto.getRandomValues(new Uint32Array(1))[0]! || 1;

export async function take(amount: 1 | 2 | 3): Promise<void> {
  if (!state) return;
  const command: TakeCommand = {
    v: 1,
    type: "take",
    commandId: nextCommandId++,
    clientNonce,
    expectedRevision: state.revision,
    amount,
  };
  pending.set(command.commandId, { command, attempts: 1, lastSentAt: performance.now() });
  await client.streams.send(encodeTakeCommand(command));
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
    await client.streams.send(encodeTakeCommand(pendingCommand.command));
  }
}

async function receive(): Promise<void> {
  for await (const event of client.streams) {
    const message = decodeServerMessage(event.bytes);
    if (!message) continue;
    // Only clear a pending command when the echo names a real command AND carries
    // this runtime's nonce. Another player's broadcast can reuse the same numeric
    // commandId, but its commandNonce differs, so it never cancels our retries.
    if (message.commandId && message.commandNonce === clientNonce) {
      pending.delete(message.commandId);
    }
    if (message.type === "state" && message.bootstrapId) {
      const ack: BootstrapAck = {
        v: 1,
        type: "bootstrap-ack",
        bootstrapId: message.bootstrapId,
      };
      await client.streams.send(encodeBootstrapAck(ack));
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

window.setInterval(() => void retryPending().catch(console.error), 250);
void receive();
```

The initial reliable state removes the startup deadlock. Retrying sends the exact same command and
`commandId`; the bounded server cache prevents double application.

These messages travel on reliable streams, which accept far more than one datagram, so this example
stays on the byte-aligned `DataView` rung. When a family must instead fit the ~1,000-byte datagram
budget or pack many entities per packet, see
[`snack-design-binary-protocol`](../../snack-design-binary-protocol/SKILL.md) for bitpacking,
quantization, delta compression against acked baselines, and priority accumulators.
