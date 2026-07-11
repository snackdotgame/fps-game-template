# Bounded Hitscan Lag Compensation Example

This example adds historical hit validation to an existing authoritative snapshot/prediction game.
It uses one logical seat per trusted `userId`; a game with multiple seats per user should use a
game-owned seat id.

## Shared Messages

Gameplay is binary from the first implementation (see
[`snack-design-binary-protocol`](../../snack-design-binary-protocol/SKILL.md)). Fire commands ride a
datagram, so their identity is compact and numeric: the round tag, the per-runtime `clientNonce`, and
the idempotency `commandId` are `uint32`, never strings. Results ride a reliable stream, where
`targetUserId` may stay a
length-prefixed UTF-8 string. Every packet leads with a `version` then a `kind` byte; local encoders
throw on bad local state, remote decoders return `undefined` on any malformed byte.

```ts
// src/shared/messages.ts
export type Vec2 = { x: number; y: number };

export type FireCommand = {
  v: 1;
  type: "fire";
  roundId: number;
  commandId: number;
  clientNonce: number;
  viewTick: number;
  origin: Vec2;
  direction: Vec2;
};

export type FireRejection =
  | "wrong-round"
  | "no-shooter"
  | "cooldown"
  | "future-view"
  | "outside-window"
  | "invalid-origin";

export type FireStatus = "hit" | "miss" | "rejected";

export type FireResult = {
  roundId: number;
  commandId: number;
  serverTick: number;
  status: FireStatus;
  reason: FireRejection | null;
  targetUserId: string | null;
};

export type FireResultBatch = {
  v: 1;
  type: "fire-results";
  results: FireResult[];
};

const PROTOCOL_VERSION = 1;
const KIND_FIRE = 1;
const KIND_FIRE_RESULTS = 2;

// version + kind + roundId/commandId/clientNonce/viewTick (uint32) + origin xy + direction xy (int16).
const FIRE_BYTES = 2 + 4 * 4 + 2 * 4;
const FIRE_RESULT_FIXED_BYTES = 4 + 4 + 4 + 1 + 1; // roundId, commandId, serverTick, status, reason
const RESULTS_MAX = 64;
const USER_ID_MAX_BYTES = 128;
const UINT32_MAX = 0xffff_ffff;

// Direction is a unit vector; each component in [-1, 1] quantizes onto int16.
const MOVE_SCALE = 32_767;

// Origin is a world position. ±256 m at 64 steps/m is ~16 mm precision, far finer than the 0.75 m
// origin tolerance the server rewind check uses, and it fits int16 (±16384 < 32767).
const WORLD_MIN = -256;
const WORLD_MAX = 256;
const POSITION_SCALE = 64;
const POSITION_MIN_STEPS = WORLD_MIN * POSITION_SCALE;
const POSITION_MAX_STEPS = WORLD_MAX * POSITION_SCALE;

// Wire enums with stable numeric tags, independent of declaration order.
const STATUS_BY_CODE = ["hit", "miss", "rejected"] as const;
const REASON_BY_CODE: readonly FireRejection[] = [
  "wrong-round",
  "no-shooter",
  "cooldown",
  "future-view",
  "outside-window",
  "invalid-origin",
];

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function writePositionAxis(view: DataView, offset: number, value: number): void {
  const clamped = Math.max(WORLD_MIN, Math.min(WORLD_MAX, value));
  view.setInt16(offset, Math.round(clamped * POSITION_SCALE), true);
}

function readPositionAxis(raw: number): number | undefined {
  if (raw < POSITION_MIN_STEPS || raw > POSITION_MAX_STEPS) return undefined;
  return raw / POSITION_SCALE;
}

function statusToCode(status: FireStatus): number {
  return status === "hit" ? 0 : status === "miss" ? 1 : 2;
}

function reasonToCode(reason: FireRejection | null): number {
  return reason === null ? 0 : REASON_BY_CODE.indexOf(reason) + 1;
}

// code 0 is the null reason; undefined means an out-of-range code.
function codeToReason(code: number): FireRejection | null | undefined {
  if (code === 0) return null;
  return REASON_BY_CODE[code - 1] ?? undefined;
}

export function encodeFireCommand(command: FireCommand): Uint8Array {
  const { origin, direction } = command;
  const length = Math.hypot(direction.x, direction.y);
  if (
    command.v !== 1 ||
    command.type !== "fire" ||
    !isUint32(command.roundId) ||
    !isUint32(command.commandId) ||
    !isUint32(command.clientNonce) ||
    !isUint32(command.viewTick) ||
    !Number.isFinite(origin.x) ||
    !Number.isFinite(origin.y) ||
    !Number.isFinite(direction.x) ||
    !Number.isFinite(direction.y) ||
    length < 0.99 ||
    length > 1.01
  ) {
    throw new Error("Invalid local fire command");
  }
  const bytes = new Uint8Array(FIRE_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_FIRE);
  view.setUint32(2, command.roundId, true);
  view.setUint32(6, command.commandId, true);
  view.setUint32(10, command.clientNonce, true);
  view.setUint32(14, command.viewTick, true);
  writePositionAxis(view, 18, origin.x);
  writePositionAxis(view, 20, origin.y);
  view.setInt16(22, Math.round(clampUnit(direction.x) * MOVE_SCALE), true);
  view.setInt16(24, Math.round(clampUnit(direction.y) * MOVE_SCALE), true);
  return bytes;
}

export function decodeFireCommand(bytes: Uint8Array): FireCommand | undefined {
  if (bytes.byteLength !== FIRE_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_FIRE) return undefined;
  const roundId = view.getUint32(2, true);
  const commandId = view.getUint32(6, true);
  const clientNonce = view.getUint32(10, true);
  const viewTick = view.getUint32(14, true);
  const originX = readPositionAxis(view.getInt16(18, true));
  const originY = readPositionAxis(view.getInt16(20, true));
  const rawDirX = view.getInt16(22, true);
  const rawDirY = view.getInt16(24, true);
  if (originX === undefined || originY === undefined) return undefined;
  if (rawDirX < -MOVE_SCALE || rawDirX > MOVE_SCALE) return undefined;
  if (rawDirY < -MOVE_SCALE || rawDirY > MOVE_SCALE) return undefined;
  const direction = { x: rawDirX / MOVE_SCALE, y: rawDirY / MOVE_SCALE };
  const length = Math.hypot(direction.x, direction.y);
  if (length < 0.99 || length > 1.01) return undefined;
  return {
    v: 1,
    type: "fire",
    roundId,
    commandId,
    clientNonce,
    viewTick,
    origin: { x: originX, y: originY },
    direction,
  };
}

export function encodeFireResultBatch(batch: FireResultBatch): Uint8Array {
  if (batch.v !== 1 || batch.type !== "fire-results" || batch.results.length > RESULTS_MAX) {
    throw new Error("Invalid local fire result batch");
  }
  const encoder = new TextEncoder();
  const entries: { result: FireResult; target: Uint8Array | null }[] = [];
  let total = 4; // version + kind + uint16 count
  for (const result of batch.results) {
    if (
      !isUint32(result.roundId) ||
      !isUint32(result.commandId) ||
      !isUint32(result.serverTick) ||
      (result.status !== "hit" && result.status !== "miss" && result.status !== "rejected") ||
      (result.reason !== null && !REASON_BY_CODE.includes(result.reason))
    ) {
      throw new Error("Invalid local fire result");
    }
    let target: Uint8Array | null = null;
    if (result.targetUserId !== null) {
      target = encoder.encode(result.targetUserId);
      if (target.byteLength > USER_ID_MAX_BYTES) throw new Error("targetUserId too long");
    }
    entries.push({ result, target });
    total += FIRE_RESULT_FIXED_BYTES + 1 + (target ? 1 + target.byteLength : 0);
  }

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_FIRE_RESULTS);
  view.setUint16(2, batch.results.length, true);
  let offset = 4;
  for (const { result, target } of entries) {
    view.setUint32(offset, result.roundId, true);
    view.setUint32(offset + 4, result.commandId, true);
    view.setUint32(offset + 8, result.serverTick, true);
    view.setUint8(offset + 12, statusToCode(result.status));
    view.setUint8(offset + 13, reasonToCode(result.reason));
    offset += FIRE_RESULT_FIXED_BYTES;
    if (target) {
      view.setUint8(offset, 1);
      view.setUint8(offset + 1, target.byteLength);
      bytes.set(target, offset + 2);
      offset += 2 + target.byteLength;
    } else {
      view.setUint8(offset, 0);
      offset += 1;
    }
  }
  return bytes;
}

export function decodeFireResultBatch(bytes: Uint8Array): FireResultBatch | undefined {
  if (bytes.byteLength < 4) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_FIRE_RESULTS) {
    return undefined;
  }
  const count = view.getUint16(2, true);
  if (count > RESULTS_MAX) return undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const results: FireResult[] = [];
  let offset = 4;
  for (let index = 0; index < count; index += 1) {
    if (offset + FIRE_RESULT_FIXED_BYTES + 1 > bytes.byteLength) return undefined;
    const roundId = view.getUint32(offset, true);
    const commandId = view.getUint32(offset + 4, true);
    const serverTick = view.getUint32(offset + 8, true);
    const status = STATUS_BY_CODE[view.getUint8(offset + 12)];
    const reason = codeToReason(view.getUint8(offset + 13));
    const targetFlag = view.getUint8(offset + 14);
    offset += FIRE_RESULT_FIXED_BYTES + 1;
    if (status === undefined || reason === undefined) return undefined;
    if (targetFlag !== 0 && targetFlag !== 1) return undefined;
    let targetUserId: string | null = null;
    if (targetFlag === 1) {
      if (offset + 1 > bytes.byteLength) return undefined;
      const length = view.getUint8(offset);
      offset += 1;
      if (length > USER_ID_MAX_BYTES || offset + length > bytes.byteLength) return undefined;
      try {
        targetUserId = decoder.decode(bytes.subarray(offset, offset + length));
      } catch {
        return undefined;
      }
      offset += length;
    }
    results.push({ roundId, commandId, serverTick, status, reason, targetUserId });
  }
  if (offset !== bytes.byteLength) return undefined; // reject trailing bytes
  return { v: 1, type: "fire-results", results };
}

export function formatFireCommandForLog(bytes: Uint8Array): string {
  const command = decodeFireCommand(bytes);
  if (!command) return `invalid fire packet (${bytes.byteLength} bytes)`;
  const { origin, direction } = command;
  return (
    `fire round=${command.roundId} cmd=${command.commandId} nonce=${command.clientNonce} ` +
    `view=${command.viewTick} ` +
    `origin=(${origin.x.toFixed(2)},${origin.y.toFixed(2)}) ` +
    `dir=(${direction.x.toFixed(3)},${direction.y.toFixed(3)})`
  );
}
```

## Authoritative History, Validation, And Batched Results

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  decodeFireCommand,
  encodeFireResultBatch,
  type FireCommand,
  type FireRejection,
  type FireResult,
  type FireResultBatch,
  type Vec2,
} from "./shared/messages.js";

const TICK_MS = 1000 / 60;
const MAX_CATCH_UP_STEPS = 4;
const MAX_REWIND_MS = 300;
const MAX_PRESENTATION_DELAY_MS = 200;
const PLAYER_RADIUS = 0.5;
const ORIGIN_TOLERANCE = 0.75;
const RESULT_FLUSH_TICKS = 3;
const ROUND_ID = 1;

type PlayerState = {
  userId: string;
  generation: number;
  activeConnectionId: string;
  position: Vec2;
  health: number;
  nextFireTick: number;
};
type HistoricalPose = { generation: number; position: Vec2 };
type HistoryEntry = { tick: number; elapsedMs: number; poses: Record<string, HistoricalPose> };

const players = new Map<string, PlayerState>();
const history: HistoryEntry[] = [];
const processed = new Map<string, FireResult>();
const pendingResults = new Map<string, FireResult[]>();
const retiredConnectionIds = new Set<string>();
let tick = 0;
let nextGeneration = 1;

export async function main(): Promise<void> {
  let nextTickMs = server.elapsedMs();
  while (server.running) {
    syncPlayers();

    const nowMs = server.elapsedMs();
    let steps = 0;
    while (nowMs >= nextTickMs && steps < MAX_CATCH_UP_STEPS) {
      tick += 1;
      recordHistory();
      nextTickMs += TICK_MS;
      steps += 1;
    }
    if (steps === MAX_CATCH_UP_STEPS && nowMs >= nextTickMs) nextTickMs = nowMs + TICK_MS;

    for (const event of server.datagrams.drain()) {
      const command = decodeFireCommand(event.bytes);
      const player = players.get(event.connection.userId);
      if (!command || player?.activeConnectionId !== event.connection.id) continue;
      const key = `${ROUND_ID}:${event.connection.userId}:${command.clientNonce}:${command.commandId}`;
      const cached = processed.get(key);
      const result = cached ?? validateFire(event.connection, command);
      remember(key, result);
      queueResult(event.connection, result);
    }
    if (tick % RESULT_FLUSH_TICKS === 0) flushResults();
    await server.sleep(Math.max(1, nextTickMs - server.elapsedMs()));
  }
}

function validateFire(connection: Connection, command: FireCommand): FireResult {
  if (command.roundId !== ROUND_ID) return rejected(command, "wrong-round");
  const shooter = players.get(connection.userId);
  if (!shooter) return rejected(command, "no-shooter");
  if (tick < shooter.nextFireTick) return rejected(command, "cooldown");
  shooter.nextFireTick = tick + 6;

  if (command.viewTick > tick) return rejected(command, "future-view");
  const rttMs = connection.net.rtt ?? 0;
  const jitterMs = connection.net.jitter ?? 0;
  const trustedWindowMs = Math.min(
    MAX_REWIND_MS,
    MAX_PRESENTATION_DELAY_MS + rttMs * 0.5 + jitterMs * 2 + TICK_MS * 2,
  );
  const snapshot = historyForTick(command.viewTick);
  if (!snapshot || server.elapsedMs() - snapshot.elapsedMs > trustedWindowMs) {
    return rejected(command, "outside-window");
  }
  const historicalShooter = snapshot.poses[connection.userId];
  if (
    !historicalShooter ||
    historicalShooter.generation !== shooter.generation ||
    distance(historicalShooter.position, command.origin) > ORIGIN_TOLERANCE
  ) {
    return rejected(command, "invalid-origin");
  }

  const hit = firstRayHit(
    historicalShooter.position,
    command.direction,
    snapshot.poses,
    connection.userId,
  );
  if (!hit) return outcome(command, "miss", null);

  const target = players.get(hit.userId);
  if (!target || target.generation !== hit.generation || target.health <= 0) {
    return outcome(command, "miss", null);
  }
  target.health = Math.max(0, target.health - 25);
  return outcome(command, "hit", hit.userId);
}

function firstRayHit(
  origin: Vec2,
  direction: Vec2,
  poses: Record<string, HistoricalPose>,
  shooterId: string,
): { userId: string; generation: number } | undefined {
  let nearest: { userId: string; generation: number; distance: number } | undefined;
  for (const [userId, pose] of Object.entries(poses)) {
    if (userId === shooterId) continue;
    const position = pose.position;
    const offsetX = position.x - origin.x;
    const offsetY = position.y - origin.y;
    const along = offsetX * direction.x + offsetY * direction.y;
    if (along < 0) continue;
    const perpendicular = Math.abs(offsetX * direction.y - offsetY * direction.x);
    if (perpendicular > PLAYER_RADIUS) continue;
    if (!nearest || along < nearest.distance) {
      nearest = { userId, generation: pose.generation, distance: along };
    }
  }
  return nearest;
}

function recordHistory(): void {
  const poses: Record<string, HistoricalPose> = {};
  for (const player of players.values()) {
    poses[player.userId] = { generation: player.generation, position: { ...player.position } };
  }
  const elapsedMs = server.elapsedMs();
  history.push({ tick, elapsedMs, poses });
  const oldestMs = elapsedMs - MAX_REWIND_MS - TICK_MS * 2;
  while ((history[0]?.elapsedMs ?? Infinity) < oldestMs) history.shift();
}

function historyForTick(targetTick: number): HistoryEntry | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry && entry.tick <= targetTick) return entry;
  }
  return undefined;
}

function syncPlayers(): void {
  const activeByUser = newestConnectionByUser();
  for (const [userId, connection] of activeByUser) {
    const player = players.get(userId);
    if (!player) {
      players.set(userId, {
        userId,
        generation: nextGeneration++,
        activeConnectionId: connection.id,
        position: { x: 0, y: 0 },
        health: 100,
        nextFireTick: 0,
      });
    } else if (player.activeConnectionId !== connection.id) {
      retiredConnectionIds.add(player.activeConnectionId);
      player.activeConnectionId = connection.id;
    }
  }
  for (const userId of players.keys()) if (!activeByUser.has(userId)) players.delete(userId);
  const connectedIds = new Set(server.connections.map((connection) => connection.id));
  for (const connectionId of retiredConnectionIds) {
    if (!connectedIds.has(connectionId)) retiredConnectionIds.delete(connectionId);
  }
}

function newestConnectionByUser(): Map<string, Connection> {
  const newest = new Map<string, Connection>();
  for (const connection of server.connections) {
    if (retiredConnectionIds.has(connection.id)) continue;
    const current = newest.get(connection.userId);
    if (
      !current ||
      connection.connectedAt > current.connectedAt ||
      (connection.connectedAt === current.connectedAt && connection.id > current.id)
    ) {
      newest.set(connection.userId, connection);
    }
  }
  return newest;
}

function outcome(
  command: FireCommand,
  status: "hit" | "miss",
  targetUserId: string | null,
): FireResult {
  return {
    roundId: ROUND_ID,
    commandId: command.commandId,
    serverTick: tick,
    status,
    reason: null,
    targetUserId,
  };
}

function rejected(command: FireCommand, reason: FireRejection): FireResult {
  return {
    roundId: ROUND_ID,
    commandId: command.commandId,
    serverTick: tick,
    status: "rejected",
    reason,
    targetUserId: null,
  };
}

function queueResult(connection: Connection, result: FireResult): void {
  let queued = pendingResults.get(connection.id);
  if (!queued) {
    queued = [];
    pendingResults.set(connection.id, queued);
  }
  if (queued.length >= 64) {
    sendResultBatch(connection, queued);
    queued.length = 0;
  }
  queued.push(result);
}

function flushResults(): void {
  for (const connection of server.connections) {
    const results = pendingResults.get(connection.id);
    if (!results || results.length === 0) continue;
    sendResultBatch(connection, results);
    pendingResults.delete(connection.id);
  }
  const connectedIds = new Set(server.connections.map((connection) => connection.id));
  for (const connectionId of pendingResults.keys()) {
    if (!connectedIds.has(connectionId)) pendingResults.delete(connectionId);
  }
}

function sendResultBatch(connection: Connection, results: FireResult[]): void {
  const batch: FireResultBatch = { v: 1, type: "fire-results", results: [...results] };
  connection.streams.send(encodeFireResultBatch(batch));
}

function remember(key: string, value: FireResult): void {
  processed.set(key, value);
  while (processed.size > 1024) {
    const oldest = processed.keys().next().value;
    if (typeof oldest !== "string") break;
    processed.delete(oldest);
  }
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
```

`ROUND_ID` is a numeric round tag standing in for the current authoritative round state. Bump it on
each round and keep it in the deduplication key. Moving cover must be recorded beside target hitboxes
and queried from the same historical tick.

## Client Fire Intent And Reliable-Router Hook

```ts
// src/client.ts
import { client } from "snack:client";
import {
  decodeFireResultBatch,
  encodeFireCommand,
  type FireCommand,
  type FireResult,
  type Vec2,
} from "./shared/messages.js";

const DATAGRAM_BUDGET_BYTES = 1000;
let activeRoundId = 1;
let renderedServerTick = 0;
// Drawn once per runtime. commandId is a per-runtime counter, so it restarts at 1 on every fresh
// launch; clientNonce distinguishes this runtime's commandId space from any prior one's.
const clientNonce = crypto.getRandomValues(new Uint32Array(1))[0]!;
let nextCommandId = 1;

export async function fire(origin: Vec2, direction: Vec2): Promise<void> {
  const command: FireCommand = {
    v: 1,
    type: "fire",
    roundId: activeRoundId,
    commandId: nextCommandId++,
    clientNonce,
    viewTick: renderedServerTick,
    origin,
    direction,
  };
  const bytes = encodeFireCommand(command);
  if (bytes.byteLength > DATAGRAM_BUDGET_BYTES) throw new RangeError("fire command is too large");
  await client.datagrams.send(bytes);
}

export function setRenderedServerTick(tick: number): void {
  renderedServerTick = Math.floor(tick);
}

export function setActiveRoundId(roundId: number): void {
  activeRoundId = roundId;
}

export function handleReliableMessage(bytes: Uint8Array): boolean {
  const batch = decodeFireResultBatch(bytes);
  if (!batch) return false;
  for (const result of batch.results) showFireResult(result);
  return true;
}

function showFireResult(result: FireResult): void {
  console.log(result);
}
```

Counter ids are only unique within one client runtime, so the nonce scopes the dedupe key across
fresh-launch rejoins while keeping dedupe by logical player rather than connection id: `ROUND_ID`
does not change on rejoin, so without the nonce a relaunched signed-in user's counter restarts at 1
and its fresh fire commands would falsely dedupe against the previous connection's still-cached
entries in the same round, silently swallowing shots.

`FireResult` deliberately does not echo `clientNonce`. Results ride a single connection's reliable
stream, and a fresh launch is a new connection, so a runtime only ever receives results for commands
it sent this runtime; within one runtime `commandId` is unique, so client-side matching of a
`FireResultBatch` entry to pending or local state keys on `commandId` alone with no cross-runtime
collision. The result layout is left unchanged.

Feed `setRenderedServerTick` the actual delayed tick used to render remote players, not the newest
received or estimated current server tick. Pass each reliable message's `event.bytes` to
`handleReliableMessage()` from the primary netcode's one reliable-stream owner; that owner decodes
the bytes, so do not start a second iterator that can consume and discard bootstrap or match
messages.

Results are batched every few server ticks and ride a reliable stream, so the batch is not bound by
the 1,000-byte datagram budget. A high-rate game may instead repeat compact result event ids in
authoritative snapshot datagrams, while health and damage remain part of normal authoritative state;
for bitpacking, delta baselines, and priority accumulators that keep those datagrams in budget, see
[`snack-design-binary-protocol`](../../snack-design-binary-protocol/SKILL.md).
