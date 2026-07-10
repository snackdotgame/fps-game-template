# Authoritative Snapshot Groups And Interpolation

This example uses datagrams for input and independently useful snapshot groups, a retried reliable
bootstrap, and a monotonic render clock that advances between packet arrivals.

## Shared Protocol

```ts
// src/shared/messages.ts
export type InputMessage = {
  v: 1;
  type: "input";
  seq: number;
  moveX: number;
  moveY: number;
};

export type PlayerSnapshot = { userId: string; generation: number; x: number; y: number };

export type SnapshotGroup = {
  v: 1;
  type: "snapshot-group";
  tick: number;
  serverTimeMs: number;
  groupId: string;
  player: PlayerSnapshot | null;
};

export type Bootstrap = {
  v: 1;
  type: "bootstrap";
  bootstrapId: string;
  groups: SnapshotGroup[];
};

export type BootstrapAck = { v: 1; type: "bootstrap-ack"; bootstrapId: string };

export function parseInput(value: unknown): InputMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "input" ||
    !Number.isSafeInteger(record.seq) ||
    typeof record.moveX !== "number" ||
    typeof record.moveY !== "number" ||
    !Number.isFinite(record.moveX) ||
    !Number.isFinite(record.moveY) ||
    Math.abs(record.moveX) > 1 ||
    Math.abs(record.moveY) > 1
  ) {
    return undefined;
  }
  return record as unknown as InputMessage;
}

export function parseSnapshotGroup(value: unknown): SnapshotGroup | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const player = record.player === null ? null : parsePlayer(record.player);
  if (
    record.v !== 1 ||
    record.type !== "snapshot-group" ||
    !Number.isSafeInteger(record.tick) ||
    typeof record.serverTimeMs !== "number" ||
    !Number.isFinite(record.serverTimeMs) ||
    typeof record.groupId !== "string" ||
    record.groupId.length > 128 ||
    player === undefined
  ) {
    return undefined;
  }
  return {
    v: 1,
    type: "snapshot-group",
    tick: record.tick as number,
    serverTimeMs: record.serverTimeMs,
    groupId: record.groupId,
    player,
  };
}

export function parseBootstrap(value: unknown): Bootstrap | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "bootstrap" ||
    typeof record.bootstrapId !== "string" ||
    !Array.isArray(record.groups) ||
    record.groups.length > 256
  ) {
    return undefined;
  }

  const groups: SnapshotGroup[] = [];
  const groupIds = new Set<string>();
  for (const value of record.groups) {
    const group = parseSnapshotGroup(value);
    if (!group || groupIds.has(group.groupId)) return undefined;
    groupIds.add(group.groupId);
    groups.push(group);
  }
  return { v: 1, type: "bootstrap", bootstrapId: record.bootstrapId, groups };
}

export function parseBootstrapAck(value: unknown): BootstrapAck | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.type !== "bootstrap-ack" || typeof record.bootstrapId !== "string") {
    return undefined;
  }
  return { v: 1, type: "bootstrap-ack", bootstrapId: record.bootstrapId };
}

function parsePlayer(value: unknown): PlayerSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const player = value as Record<string, unknown>;
  if (
    typeof player.userId !== "string" ||
    !Number.isSafeInteger(player.generation) ||
    typeof player.x !== "number" ||
    typeof player.y !== "number" ||
    !Number.isFinite(player.x) ||
    !Number.isFinite(player.y)
  ) {
    return undefined;
  }
  return {
    userId: player.userId,
    generation: player.generation as number,
    x: player.x,
    y: player.y,
  };
}
```

## Authoritative Server Loop

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  parseBootstrapAck,
  parseInput,
  type Bootstrap,
  type PlayerSnapshot,
  type SnapshotGroup,
} from "./shared/messages.js";

type PlayerState = PlayerSnapshot & {
  activeConnectionId: string | null;
  inputX: number;
  inputY: number;
  lastInputSeq: number;
  lastInputAtMs: number;
};

type PendingBootstrap = {
  message: Bootstrap;
  lastSentAtMs: number;
  attempts: number;
  acknowledged: boolean;
};

const DATAGRAM_BUDGET_BYTES = 1000;
const BOOTSTRAP_RETRY_MS = 500;
const MAX_BOOTSTRAP_ATTEMPTS = 20;
const players = new Map<string, PlayerState>();
const pendingBootstraps = new Map<string, PendingBootstrap>();
const retiredConnectionIds = new Set<string>();
const tombstones = new Map<string, number>();
let tick = 0;
let lastTimeMs = 0;
let nextBootstrapId = 0;
let nextGeneration = 1;

export async function main(): Promise<void> {
  lastTimeMs = server.elapsedMs();
  while (server.running) {
    syncConnections();
    readInputs();
    readBootstrapAcks();

    const nowMs = server.elapsedMs();
    const dt = Math.min(0.05, Math.max(0, (nowMs - lastTimeMs) / 1000));
    lastTimeMs = nowMs;
    simulateAuthoritative(dt);
    tick += 1;

    const groups = makeSnapshotGroups(nowMs);
    sendBootstraps(groups);
    if (tick % 3 === 0) {
      const readyConnectionIds = acknowledgedConnectionIds();
      for (const group of groups) {
        if (encodedBytes(group) <= DATAGRAM_BUDGET_BYTES) {
          if (readyConnectionIds.length > 0) {
            server.datagrams.broadcast(group, { only: readyConnectionIds });
          }
        } else {
          console.warn("snapshot group exceeds the datagram budget; compact or interest-manage it");
        }
      }
    }
    await server.sleep(16);
  }
}

function readInputs(): void {
  for (const event of server.datagrams.drain()) {
    const input = parseInput(safeJson(event));
    const player = players.get(event.connection.userId);
    if (
      !input ||
      !player ||
      retiredConnectionIds.has(event.connection.id) ||
      player.activeConnectionId !== event.connection.id ||
      !pendingBootstraps.get(event.connection.id)?.acknowledged ||
      input.seq <= player.lastInputSeq
    ) {
      continue;
    }
    if (input.seq > player.lastInputSeq + 120) player.lastInputSeq = input.seq - 1;
    player.lastInputSeq = input.seq;
    player.inputX = input.moveX;
    player.inputY = input.moveY;
    player.lastInputAtMs = server.elapsedMs();
  }
}

function readBootstrapAcks(): void {
  for (const event of server.streams.drain()) {
    const ack = parseBootstrapAck(safeJson(event));
    const pending = pendingBootstraps.get(event.connection.id);
    if (
      !ack ||
      pending?.message.bootstrapId !== ack.bootstrapId ||
      pending.acknowledged ||
      retiredConnectionIds.has(event.connection.id)
    ) {
      continue;
    }
    const newest = newestConnectionByUser().get(event.connection.userId);
    if (newest?.id !== event.connection.id) continue;
    pending.acknowledged = true;
    activatePlayer(event.connection);
  }
}

function simulateAuthoritative(dt: number): void {
  const nowMs = server.elapsedMs();
  for (const player of players.values()) {
    const inputActive = nowMs - player.lastInputAtMs <= 250;
    player.x += (inputActive ? player.inputX : 0) * 4 * dt;
    player.y += (inputActive ? player.inputY : 0) * 4 * dt;
  }
}

function syncConnections(): void {
  const activeByUser = newestConnectionByUser();
  const connectedIds = new Set(server.connections.map((connection) => connection.id));
  for (const connection of server.connections) {
    const newest = activeByUser.get(connection.userId);
    if (newest?.id !== connection.id && !retiredConnectionIds.has(connection.id)) {
      retiredConnectionIds.add(connection.id);
      pendingBootstraps.delete(connection.id);
    }
  }
  for (const [userId, connection] of activeByUser) {
    const player = players.get(userId);
    if (player?.activeConnectionId && player.activeConnectionId !== connection.id) {
      retiredConnectionIds.add(player.activeConnectionId);
      pendingBootstraps.delete(player.activeConnectionId);
      player.activeConnectionId = null;
      player.inputX = 0;
      player.inputY = 0;
      player.lastInputSeq = -1;
      player.lastInputAtMs = -Infinity;
    }
  }
  for (const userId of players.keys()) {
    if (!activeByUser.has(userId)) {
      players.delete(userId);
      tombstones.set(userId, tick + 60);
    }
  }
  for (const connectionId of pendingBootstraps.keys()) {
    if (!connectedIds.has(connectionId)) pendingBootstraps.delete(connectionId);
  }
  for (const connectionId of retiredConnectionIds) {
    if (!connectedIds.has(connectionId)) retiredConnectionIds.delete(connectionId);
  }
}

function activatePlayer(connection: Connection): void {
  const player = players.get(connection.userId);
  if (!player) {
    players.set(connection.userId, {
      userId: connection.userId,
      generation: nextGeneration++,
      activeConnectionId: connection.id,
      x: 0,
      y: 0,
      inputX: 0,
      inputY: 0,
      lastInputSeq: -1,
      lastInputAtMs: -Infinity,
    });
  } else {
    player.activeConnectionId = connection.id;
    player.inputX = 0;
    player.inputY = 0;
    player.lastInputSeq = -1;
    player.lastInputAtMs = -Infinity;
  }
  tombstones.delete(connection.userId);
}

function acknowledgedConnectionIds(): string[] {
  return [...players.values()]
    .map((player) => player.activeConnectionId)
    .filter(
      (connectionId): connectionId is string =>
        connectionId !== null &&
        !retiredConnectionIds.has(connectionId) &&
        pendingBootstraps.get(connectionId)?.acknowledged === true,
    );
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

function makeSnapshotGroups(serverTimeMs: number): SnapshotGroup[] {
  const groups = [...players.values()].map(({ userId, generation, x, y }) =>
    groupMessage(serverTimeMs, userId, { userId, generation, x, y }),
  );
  for (const [groupId, expiresAtTick] of tombstones) {
    if (tick > expiresAtTick) {
      tombstones.delete(groupId);
    } else if (!players.has(groupId)) {
      groups.push(groupMessage(serverTimeMs, groupId, null));
    }
  }
  return groups;
}

function groupMessage(
  serverTimeMs: number,
  groupId: string,
  player: PlayerSnapshot | null,
): SnapshotGroup {
  return {
    v: 1,
    type: "snapshot-group",
    tick,
    serverTimeMs,
    groupId,
    player,
  };
}

function encodedBytes(message: SnapshotGroup): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

function sendBootstraps(groups: SnapshotGroup[]): void {
  const nowMs = server.elapsedMs();
  const activeByUser = newestConnectionByUser();
  for (const connection of server.connections) {
    if (activeByUser.get(connection.userId)?.id !== connection.id) continue;
    let pending = pendingBootstraps.get(connection.id);
    if (!pending) {
      pending = {
        message: {
          v: 1,
          type: "bootstrap",
          bootstrapId: `${connection.id}:${nextBootstrapId++}`,
          groups: groups.filter((group) => group.player !== null),
        },
        lastSentAtMs: -Infinity,
        attempts: 0,
        acknowledged: false,
      };
      pendingBootstraps.set(connection.id, pending);
    }
    if (pending.acknowledged) continue;
    if (pending.attempts >= MAX_BOOTSTRAP_ATTEMPTS) {
      retiredConnectionIds.add(connection.id);
      pendingBootstraps.delete(connection.id);
      continue;
    }
    if (nowMs - pending.lastSentAtMs < BOOTSTRAP_RETRY_MS) continue;
    connection.streams.send(pending.message);
    pending.lastSentAtMs = nowMs;
    pending.attempts += 1;
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

Each per-player group has a stable id and generation, and disconnect tombstones repeat for several
snapshot intervals. It can advance even when another group is lost. Large worlds should use stable
spatial interest groups, compact numeric entity ids, quantization, and the same generation/tombstone
rules instead of sending one datagram per entity.

## Shared Interpolation Timing

```ts
// src/shared/interpolation.ts
import type { SnapshotGroup } from "./messages.js";

export type ReceivedGroup = { group: SnapshotGroup; receivedAtMs: number };

export const GROUP_HEALTH_TIMEOUT_MS = 250;

export function pruneUnhealthyGroups(histories: Map<string, ReceivedGroup[]>, nowMs: number): void {
  for (const [groupId, history] of histories) {
    if (nowMs - (history.at(-1)?.receivedAtMs ?? -Infinity) > GROUP_HEALTH_TIMEOUT_MS) {
      histories.delete(groupId);
    }
  }
}

export function nextCommonRenderTimeMs(
  currentTimeMs: number,
  candidateTimeMs: number,
  histories: Map<string, ReceivedGroup[]>,
): number {
  if (histories.size === 0) return currentTimeMs;
  const slowestNewestTimeMs = Math.min(
    ...[...histories.values()].map((history) => history.at(-1)?.group.serverTimeMs ?? Infinity),
  );
  return Math.max(currentTimeMs, Math.min(candidateTimeMs, slowestNewestTimeMs));
}
```

## Client Jitter Buffer And Interpolation

```ts
// src/client.ts
import { client } from "snack:client";
import {
  parseBootstrap,
  parseSnapshotGroup,
  type BootstrapAck,
  type InputMessage,
  type PlayerSnapshot,
  type SnapshotGroup,
} from "./shared/messages.js";
import {
  nextCommonRenderTimeMs,
  pruneUnhealthyGroups,
  type ReceivedGroup,
} from "./shared/interpolation.js";

type SampledGroup = { renderTick: number; newestTick: number; player: PlayerSnapshot };
type RenderedSnapshot = { renderTick: number; players: PlayerSnapshot[] };

const histories = new Map<string, ReceivedGroup[]>();
const latestGroupTicks = new Map<string, number>();
let inputSeq = 0;
let moveX = 0;
let moveY = 0;
let lastInputSentAtMs = -Infinity;
let clockOffsetMs: number | undefined;
let interpolationDelayMs = 100;
let lastDelayUpdateMs = 0;
let renderServerTimeMs = -Infinity;
let renderedServerTick = 0;

export function setMoveIntent(nextMoveX: number, nextMoveY: number): void {
  moveX = Math.min(1, Math.max(-1, nextMoveX));
  moveY = Math.min(1, Math.max(-1, nextMoveY));
}

async function sendCurrentInput(): Promise<void> {
  const input: InputMessage = { v: 1, type: "input", seq: inputSeq++, moveX, moveY };
  await client.datagrams.send(input);
}

export function getRenderedServerTick(): number {
  return renderedServerTick;
}

function pushGroup(group: SnapshotGroup, receivedAtMs: number): void {
  const latestTick = latestGroupTicks.get(group.groupId) ?? -1;
  if (group.tick <= latestTick) return;
  latestGroupTicks.set(group.groupId, group.tick);
  if (!group.player) {
    histories.delete(group.groupId);
    return;
  }

  let history = histories.get(group.groupId);
  if (history?.at(-1)?.group.player?.generation !== group.player.generation) {
    history = [];
    histories.set(group.groupId, history);
  }
  if (!history) {
    history = [];
    histories.set(group.groupId, history);
  }
  history.push({ group, receivedAtMs });
  while (history.length > 32) history.shift();

  const sampleOffsetMs = group.serverTimeMs - receivedAtMs;
  clockOffsetMs = Math.max(clockOffsetMs ?? sampleOffsetMs, sampleOffsetMs);
}

async function receiveReliableMessages(): Promise<void> {
  for await (const event of client.streams) {
    const message = parseBootstrap(safeJson(event));
    if (!message) continue;
    for (const group of message.groups) pushGroup(group, performance.now());
    const ack: BootstrapAck = {
      v: 1,
      type: "bootstrap-ack",
      bootstrapId: message.bootstrapId,
    };
    await client.streams.send(ack);
  }
}

function frame(nowMs: number): void {
  for (const event of client.datagrams.drain()) {
    const group = parseSnapshotGroup(safeJson(event));
    if (group) pushGroup(group, nowMs);
  }
  const sampled = samplePlayers(nowMs);
  renderedServerTick = Math.max(renderedServerTick, sampled.renderTick);
  renderPlayers(sampled.players);
  if (document.visibilityState === "visible" && nowMs - lastInputSentAtMs >= 50) {
    lastInputSentAtMs = nowMs;
    void sendCurrentInput().catch(console.error);
  }
  requestAnimationFrame(frame);
}

function samplePlayers(nowMs: number): RenderedSnapshot {
  updateInterpolationDelay(nowMs);
  pruneUnhealthyGroups(histories, nowMs);
  if (clockOffsetMs === undefined || histories.size === 0) {
    return { renderTick: renderedServerTick, players: [] };
  }

  const candidateTimeMs = nowMs + clockOffsetMs - interpolationDelayMs;
  renderServerTimeMs = nextCommonRenderTimeMs(renderServerTimeMs, candidateTimeMs, histories);
  const sampledGroups = [...histories.values()]
    .map((history) => sampleGroup(history, renderServerTimeMs))
    .filter((group): group is SampledGroup => group !== undefined);

  const byUser = new Map(sampledGroups.map((group) => [group.player.userId, group.player]));
  const renderTick = Math.min(...sampledGroups.map((group) => group.renderTick));
  return {
    renderTick: Number.isFinite(renderTick)
      ? Math.max(renderedServerTick, renderTick)
      : renderedServerTick,
    players: [...byUser.values()],
  };
}

function sampleGroup(history: ReceivedGroup[], targetTimeMs: number): SampledGroup | undefined {
  const newest = history.at(-1);
  if (!newest?.group.player) return undefined;
  let older = history[0] ?? newest;
  let newer = newest;
  for (let index = 1; index < history.length; index += 1) {
    const candidate = history[index];
    if (candidate && candidate.group.serverTimeMs >= targetTimeMs) {
      newer = candidate;
      older = history[index - 1] ?? candidate;
      break;
    }
  }

  const span = Math.max(1, newer.group.serverTimeMs - older.group.serverTimeMs);
  const alpha = Math.min(1, Math.max(0, (targetTimeMs - older.group.serverTimeMs) / span));
  const previous = older.group.player ?? newest.group.player;
  const player = newer.group.player ?? newest.group.player;
  return {
    renderTick: older.group.tick + (newer.group.tick - older.group.tick) * alpha,
    newestTick: newest.group.tick,
    player: {
      userId: player.userId,
      generation: player.generation,
      x: previous.x + (player.x - previous.x) * alpha,
      y: previous.y + (player.y - previous.y) * alpha,
    },
  };
}

function updateInterpolationDelay(nowMs: number): void {
  if (nowMs - lastDelayUpdateMs < 1000) return;
  lastDelayUpdateMs = nowMs;
  const jitterMs = client.net.jitter ?? 0;
  const desiredMs = Math.min(200, Math.max(80, 80 + jitterMs * 2));
  if (desiredMs > interpolationDelayMs)
    interpolationDelayMs = Math.min(desiredMs, interpolationDelayMs + 10);
  if (desiredMs < interpolationDelayMs)
    interpolationDelayMs = Math.max(desiredMs, interpolationDelayMs - 10);
}

function renderPlayers(players: PlayerSnapshot[]): void {
  console.log(players);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  moveX = 0;
  moveY = 0;
  void sendCurrentInput().catch(console.error);
});

function safeJson(event: { json(): unknown }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
}

void receiveReliableMessages();
requestAnimationFrame(frame);
```

The maximum observed server/local clock offset never decreases, and `renderServerTimeMs` is
monotonic. A larger jitter delay can temporarily hold presentation instead of moving it backward.
Groups that stop updating are hidden within 250 ms so one unhealthy group cannot freeze the common
view tick beyond the lag-compensation history window. Feed `getRenderedServerTick()` into
lag-compensated fire intent when that skill is selected.

This standalone client owns both receive queues. Merge additional message parsers into these owners
instead of starting another iterator or drain loop.
