# Bounded Hitscan Lag Compensation Example

This example adds historical hit validation to an existing authoritative snapshot/prediction game.
It uses one logical seat per trusted `userId`; a game with multiple seats per user should use a
game-owned seat id.

## Shared Messages

```ts
// src/shared/messages.ts
export type Vec2 = { x: number; y: number };

export type FireCommand = {
  v: 1;
  type: "fire";
  roundId: string;
  commandId: string;
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

export type FireResult = {
  roundId: string;
  commandId: string;
  serverTick: number;
  status: "hit" | "miss" | "rejected";
  reason: FireRejection | null;
  targetUserId: string | null;
};

export type FireResultBatch = {
  v: 1;
  type: "fire-results";
  results: FireResult[];
};

export function parseFireCommand(value: unknown): FireCommand | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const origin = parseVec2(record.origin);
  const direction = parseVec2(record.direction);
  if (
    record.v !== 1 ||
    record.type !== "fire" ||
    typeof record.roundId !== "string" ||
    record.roundId.length > 80 ||
    typeof record.commandId !== "string" ||
    record.commandId.length > 80 ||
    !Number.isSafeInteger(record.viewTick) ||
    !origin ||
    !direction
  ) {
    return undefined;
  }
  const length = Math.hypot(direction.x, direction.y);
  if (length < 0.99 || length > 1.01) return undefined;
  return {
    v: 1,
    type: "fire",
    roundId: record.roundId,
    commandId: record.commandId,
    viewTick: record.viewTick as number,
    origin,
    direction,
  };
}

export function parseFireResultBatch(value: unknown): FireResultBatch | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "fire-results" ||
    !Array.isArray(record.results) ||
    record.results.length > 64
  ) {
    return undefined;
  }
  const results: FireResult[] = [];
  for (const value of record.results) {
    const result = parseFireResult(value);
    if (!result) return undefined;
    results.push(result);
  }
  return { v: 1, type: "fire-results", results };
}

function parseFireResult(value: unknown): FireResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status;
  const reason = record.reason;
  if (
    typeof record.roundId !== "string" ||
    typeof record.commandId !== "string" ||
    !Number.isSafeInteger(record.serverTick) ||
    (status !== "hit" && status !== "miss" && status !== "rejected") ||
    (reason !== null &&
      reason !== "wrong-round" &&
      reason !== "no-shooter" &&
      reason !== "cooldown" &&
      reason !== "future-view" &&
      reason !== "outside-window" &&
      reason !== "invalid-origin") ||
    (typeof record.targetUserId !== "string" && record.targetUserId !== null)
  ) {
    return undefined;
  }
  return {
    roundId: record.roundId,
    commandId: record.commandId,
    serverTick: record.serverTick as number,
    status,
    reason,
    targetUserId: record.targetUserId,
  };
}

function parseVec2(value: unknown): Vec2 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.x !== "number" ||
    !Number.isFinite(record.x) ||
    typeof record.y !== "number" ||
    !Number.isFinite(record.y)
  ) {
    return undefined;
  }
  return { x: record.x, y: record.y };
}
```

## Authoritative History, Validation, And Batched Results

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  parseFireCommand,
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
const ROUND_ID = "example-round-1";

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
      const command = parseFireCommand(safeJson(event));
      const player = players.get(event.connection.userId);
      if (!command || player?.activeConnectionId !== event.connection.id) continue;
      const key = `${ROUND_ID}:${event.connection.userId}:${command.commandId}`;
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
  connection.streams.send(batch);
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

function safeJson(event: { json(): unknown }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
}
```

`ROUND_ID` stands in for the current authoritative round state. Change it on each round and keep it
in the deduplication key. Moving cover must be recorded beside target hitboxes and queried from the
same historical tick.

## Client Fire Intent And Reliable-Router Hook

```ts
// src/client.ts
import { client } from "snack:client";
import {
  parseFireResultBatch,
  type FireCommand,
  type FireResult,
  type Vec2,
} from "./shared/messages.js";

const DATAGRAM_BUDGET_BYTES = 1000;
let activeRoundId = "example-round-1";
let renderedServerTick = 0;

export async function fire(origin: Vec2, direction: Vec2): Promise<void> {
  const command: FireCommand = {
    v: 1,
    type: "fire",
    roundId: activeRoundId,
    commandId: crypto.randomUUID(),
    viewTick: renderedServerTick,
    origin,
    direction,
  };
  const byteLength = new TextEncoder().encode(JSON.stringify(command)).byteLength;
  if (byteLength > DATAGRAM_BUDGET_BYTES) throw new RangeError("fire command is too large");
  await client.datagrams.send(command);
}

export function setRenderedServerTick(tick: number): void {
  renderedServerTick = Math.floor(tick);
}

export function setActiveRoundId(roundId: string): void {
  activeRoundId = roundId;
}

export function handleReliableMessage(value: unknown): boolean {
  const batch = parseFireResultBatch(value);
  if (!batch) return false;
  for (const result of batch.results) showFireResult(result);
  return true;
}

function showFireResult(result: FireResult): void {
  console.log(result);
}
```

Feed `setRenderedServerTick` the actual delayed tick used to render remote players, not the newest
received or estimated current server tick. Pass the defensively decoded value to
`handleReliableMessage()` from the primary netcode's one reliable-stream owner; do not start a
second iterator that can consume and discard bootstrap or match messages.

Results are batched every few server ticks. A high-rate game may instead repeat compact result event
ids in authoritative snapshots, while health and damage remain part of normal authoritative state.
