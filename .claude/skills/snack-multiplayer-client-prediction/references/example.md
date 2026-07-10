# Input Replay And Reconciliation Example

This example predicts one small kinematic local controller. The server sends each connection only
its own authoritative correction; remote entities should use the snapshot/interpolation skill.

## Shared Predictable Step

```ts
// src/shared/prediction.ts
export type MoveInput = {
  seq: number;
  moveX: number;
  moveY: number;
};

export type PlayerState = {
  x: number;
  y: number;
};

const STEP_SECONDS = 1 / 60;
const SPEED = 4;

export function stepPlayer(state: PlayerState, input: MoveInput): PlayerState {
  const length = Math.hypot(input.moveX, input.moveY);
  const scale = length > 1 ? 1 / length : 1;
  return {
    x: state.x + input.moveX * scale * SPEED * STEP_SECONDS,
    y: state.y + input.moveY * scale * SPEED * STEP_SECONDS,
  };
}
```

This function is replayable enough for frequent correction. It is not proof that a whole physics
simulation is deterministic.

## Shared Messages

```ts
// src/shared/messages.ts
import type { MoveInput, PlayerState } from "./prediction.js";

export type InputPacket = {
  v: 1;
  type: "inputs";
  inputs: MoveInput[];
};

export type PlayerSnapshot = PlayerState & {
  userId: string;
  ackInputSeq: number;
};

export type Snapshot = {
  v: 1;
  type: "snapshot";
  tick: number;
  player: PlayerSnapshot;
};

export type Bootstrap = {
  v: 1;
  type: "bootstrap";
  bootstrapId: string;
  snapshot: Snapshot;
};

export type BootstrapAck = { v: 1; type: "bootstrap-ack"; bootstrapId: string };

export function parseInputPacket(value: unknown): InputPacket | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.type !== "inputs" || !Array.isArray(record.inputs)) return undefined;

  const inputs: MoveInput[] = [];
  for (const value of record.inputs.slice(0, 8)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(input.seq) ||
      typeof input.moveX !== "number" ||
      typeof input.moveY !== "number" ||
      !Number.isFinite(input.moveX) ||
      !Number.isFinite(input.moveY) ||
      Math.abs(input.moveX) > 1 ||
      Math.abs(input.moveY) > 1
    ) {
      return undefined;
    }
    inputs.push({ seq: input.seq as number, moveX: input.moveX, moveY: input.moveY });
  }
  return { v: 1, type: "inputs", inputs };
}

export function parseSnapshot(value: unknown): Snapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const player = parsePlayer(record.player);
  if (
    record.v !== 1 ||
    record.type !== "snapshot" ||
    !Number.isSafeInteger(record.tick) ||
    !player
  ) {
    return undefined;
  }
  return { v: 1, type: "snapshot", tick: record.tick as number, player };
}

export function parseBootstrap(value: unknown): Bootstrap | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const snapshot = parseSnapshot(record.snapshot);
  if (
    record.v !== 1 ||
    record.type !== "bootstrap" ||
    typeof record.bootstrapId !== "string" ||
    !snapshot
  ) {
    return undefined;
  }
  return { v: 1, type: "bootstrap", bootstrapId: record.bootstrapId, snapshot };
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
    typeof player.x !== "number" ||
    typeof player.y !== "number" ||
    !Number.isFinite(player.x) ||
    !Number.isFinite(player.y) ||
    !Number.isSafeInteger(player.ackInputSeq)
  ) {
    return undefined;
  }
  return {
    userId: player.userId,
    x: player.x,
    y: player.y,
    ackInputSeq: player.ackInputSeq as number,
  };
}
```

## Authoritative Server

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  parseBootstrapAck,
  parseInputPacket,
  type Bootstrap,
  type PlayerSnapshot,
  type Snapshot,
} from "./shared/messages.js";
import { stepPlayer, type MoveInput, type PlayerState } from "./shared/prediction.js";

type Authority = {
  activeConnectionId: string;
  state: PlayerState;
  lastProcessedSeq: number;
  buffered: Map<number, MoveInput>;
  gapWaitTicks: number;
};

type PendingBootstrap = {
  message: Bootstrap;
  lastSentAtMs: number;
  attempts: number;
  acknowledged: boolean;
};

// This example gives one logical player to each trusted userId. Multiple connections share it.
const players = new Map<string, Authority>();
const pendingBootstraps = new Map<string, PendingBootstrap>();
const retiredConnectionIds = new Set<string>();
const TICK_MS = 1000 / 60;
const MAX_CATCH_UP_STEPS = 4;
const BOOTSTRAP_RETRY_MS = 500;
const MAX_BOOTSTRAP_ATTEMPTS = 20;
let tick = 0;
let nextBootstrapId = 0;

export async function main(): Promise<void> {
  let nextTickMs = server.elapsedMs();
  while (server.running) {
    syncConnections();
    receiveInputs();
    receiveBootstrapAcks();
    sendBootstraps();

    const nowMs = server.elapsedMs();
    let steps = 0;
    while (nowMs >= nextTickMs && steps < MAX_CATCH_UP_STEPS) {
      simulateOneStep();
      tick += 1;
      if (tick % 3 === 0) sendCorrections();
      nextTickMs += TICK_MS;
      steps += 1;
    }
    if (steps === MAX_CATCH_UP_STEPS && nowMs >= nextTickMs) nextTickMs = nowMs + TICK_MS;
    await server.sleep(Math.max(1, nextTickMs - server.elapsedMs()));
  }
}

function receiveInputs(): void {
  for (const event of server.datagrams.drain()) {
    const packet = parseInputPacket(safeJson(event));
    const player = players.get(event.connection.userId);
    if (
      !player ||
      player.activeConnectionId !== event.connection.id ||
      !pendingBootstraps.get(event.connection.id)?.acknowledged ||
      !packet
    ) {
      continue;
    }

    for (const input of packet.inputs) {
      if (input.seq <= player.lastProcessedSeq) continue;
      if (input.seq > player.lastProcessedSeq + 120) {
        player.buffered.clear();
        player.lastProcessedSeq = input.seq - 1;
      }
      player.buffered.set(input.seq, input);
    }
  }
}

function simulateOneStep(): void {
  for (const player of players.values()) {
    let nextSeq = player.lastProcessedSeq + 1;
    let input = player.buffered.get(nextSeq);
    if (!input && player.buffered.size > 0) {
      player.gapWaitTicks += 1;
      if (player.gapWaitTicks < 3) continue;
      nextSeq = Math.min(...player.buffered.keys());
      player.lastProcessedSeq = nextSeq - 1;
      input = player.buffered.get(nextSeq);
    }
    if (!input) {
      player.gapWaitTicks = 0;
      continue;
    }
    player.gapWaitTicks = 0;
    player.buffered.delete(nextSeq);
    player.state = stepPlayer(player.state, input);
    player.lastProcessedSeq = nextSeq;
  }
}

function syncConnections(): void {
  const activeByUser = newestConnectionByUser();
  const connectedUsers = new Set(activeByUser.keys());
  const connectedIds = new Set(server.connections.map((connection) => connection.id));
  for (const [userId, connection] of activeByUser) {
    const player = players.get(userId);
    if (!player) {
      players.set(userId, {
        activeConnectionId: connection.id,
        state: { x: 0, y: 0 },
        lastProcessedSeq: -1,
        buffered: new Map(),
        gapWaitTicks: 0,
      });
    } else if (player.activeConnectionId !== connection.id) {
      retiredConnectionIds.add(player.activeConnectionId);
      player.activeConnectionId = connection.id;
      player.lastProcessedSeq = -1;
      player.buffered.clear();
      player.gapWaitTicks = 0;
    }
  }
  for (const userId of players.keys()) {
    if (!connectedUsers.has(userId)) players.delete(userId);
  }
  for (const connectionId of pendingBootstraps.keys()) {
    if (!connectedIds.has(connectionId)) pendingBootstraps.delete(connectionId);
  }
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

function makeSnapshot(userId: string, player: Authority): Snapshot {
  const playerSnapshot: PlayerSnapshot = {
    userId,
    x: player.state.x,
    y: player.state.y,
    ackInputSeq: player.lastProcessedSeq,
  };
  return { v: 1, type: "snapshot", tick, player: playerSnapshot };
}

function sendCorrections(): void {
  for (const connection of server.connections) {
    const player = players.get(connection.userId);
    if (player?.activeConnectionId === connection.id) {
      connection.datagrams.send(makeSnapshot(connection.userId, player));
    }
  }
}

function sendBootstraps(): void {
  const nowMs = server.elapsedMs();
  for (const connection of server.connections) {
    const player = players.get(connection.userId);
    if (!player || player.activeConnectionId !== connection.id) continue;
    let pending = pendingBootstraps.get(connection.id);
    if (!pending) {
      pending = {
        message: {
          v: 1,
          type: "bootstrap",
          bootstrapId: `${connection.id}:${nextBootstrapId++}`,
          snapshot: makeSnapshot(connection.userId, player),
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
      continue;
    }
    if (nowMs - pending.lastSentAtMs < BOOTSTRAP_RETRY_MS) continue;
    connection.streams.send(pending.message);
    pending.lastSentAtMs = nowMs;
    pending.attempts += 1;
  }
}

function receiveBootstrapAcks(): void {
  for (const event of server.streams.drain()) {
    const ack = parseBootstrapAck(safeJson(event));
    const pending = pendingBootstraps.get(event.connection.id);
    if (ack && pending?.message.bootstrapId === ack.bootstrapId) {
      pending.acknowledged = true;
    }
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

Each correction is small and targeted. Do not replace it with an unbounded full-world datagram;
remote players belong in independently useful snapshot groups, deltas, and interest-managed state.

## Predicting Client

```ts
// src/client.ts
import { client } from "snack:client";
import {
  parseBootstrap,
  parseSnapshot,
  type BootstrapAck,
  type InputPacket,
  type Snapshot,
} from "./shared/messages.js";
import { stepPlayer, type MoveInput, type PlayerState } from "./shared/prediction.js";

const STEP_MS = 1000 / 60;
const DATAGRAM_BUDGET_BYTES = 1000;
let predicted: PlayerState = { x: 0, y: 0 };
let rendered: PlayerState = { ...predicted };
let nextSeq = 0;
let pending: MoveInput[] = [];
let localUserId = "";
let lastSnapshotTick = -1;
let previousFrameMs = performance.now();
let accumulatorMs = 0;

async function start(): Promise<void> {
  localUserId = (await client.connection).userId;
  void receiveBootstraps();
  requestAnimationFrame(frame);
}

function predictStep(): void {
  const axes = readMoveAxes();
  queuePredictedInput(axes.x, axes.y);
}

function queuePredictedInput(moveX: number, moveY: number): void {
  const input: MoveInput = { seq: nextSeq++, moveX, moveY };
  predicted = stepPlayer(predicted, input);
  pending.push(input);
  if (pending.length > 120) pending.shift();

  const packet = makeInputPacket(pending);
  void client.datagrams.send(packet).catch(console.error);
}

function makeInputPacket(inputs: MoveInput[]): InputPacket {
  const selected: MoveInput[] = [];
  for (const input of inputs.slice(-8).reverse()) {
    const candidate: InputPacket = { v: 1, type: "inputs", inputs: [input, ...selected] };
    if (encodedBytes(candidate) > DATAGRAM_BUDGET_BYTES) break;
    selected.unshift(input);
  }
  return { v: 1, type: "inputs", inputs: selected };
}

function encodedBytes(packet: InputPacket): number {
  return new TextEncoder().encode(JSON.stringify(packet)).byteLength;
}

function reconcile(snapshot: Snapshot): void {
  if (snapshot.tick <= lastSnapshotTick || snapshot.player.userId !== localUserId) return;
  lastSnapshotTick = snapshot.tick;

  const before = predicted;
  predicted = { x: snapshot.player.x, y: snapshot.player.y };
  pending = pending.filter((input) => input.seq > snapshot.player.ackInputSeq);
  for (const input of pending) predicted = stepPlayer(predicted, input);

  const error = Math.hypot(predicted.x - before.x, predicted.y - before.y);
  if (error > 2) rendered = { ...predicted };
}

async function receiveBootstraps(): Promise<void> {
  for await (const event of client.streams) {
    const message = parseBootstrap(safeJson(event));
    if (!message) continue;
    reconcile(message.snapshot);
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
    const snapshot = parseSnapshot(safeJson(event));
    if (snapshot) reconcile(snapshot);
  }

  const elapsed = Math.min(100, nowMs - previousFrameMs);
  previousFrameMs = nowMs;
  if (document.visibilityState === "visible") {
    accumulatorMs += elapsed;
    let steps = 0;
    while (accumulatorMs >= STEP_MS && steps < 5) {
      predictStep();
      accumulatorMs -= STEP_MS;
      steps += 1;
    }
  } else {
    accumulatorMs = 0;
  }

  rendered.x += (predicted.x - rendered.x) * 0.25;
  rendered.y += (predicted.y - rendered.y) * 0.25;
  renderLocalPlayer(rendered);
  requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") queuePredictedInput(0, 0);
  previousFrameMs = performance.now();
  accumulatorMs = 0;
});

function readMoveAxes(): { x: number; y: number } {
  return { x: 0, y: 0 };
}

function renderLocalPlayer(state: PlayerState): void {
  console.log(state);
}

function safeJson(event: { json(): unknown }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
}

void start();
```

`requestAnimationFrame` supplies a bounded fixed-step accumulator and naturally pauses in a hidden
tab. The visibility handler sends neutral input so the authority does not keep applying a held
direction. On return, authoritative reconciliation corrects any missed time.

## Non-Deterministic Variant

If the authoritative player uses non-replayable physics:

1. send sequenced input intent
2. animate a local presentation proxy immediately
3. accept authoritative position and velocity
4. blend or snap the proxy toward authority within explicit thresholds
5. never feed that proxy into physics, hits, or shared game state

That gives immediate feedback with authoritative correction. It is not deterministic rollback.

This standalone client owns the reliable stream iterator and datagram drain. Merge additional
message parsers into those owners rather than starting competing consumers.
