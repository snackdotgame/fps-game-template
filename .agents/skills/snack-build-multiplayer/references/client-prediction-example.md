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

These families use a compact binary wire format instead of JSON: every packet leads with a
`version` and `kind` byte, numeric fields go through `DataView`, and the encoders and decoders live
beside the logical types. Local encoders throw on invalid local state; remote decoders validate
length, version, kind, ranges, and counts, and return `undefined` on anything malformed. Inputs and
snapshots are datagrams sized well under the 1,000-byte budget; bootstraps and acks travel on the
reliable stream, which also carries the numeric-player-id-to-`userId` mapping.

```ts
// src/shared/messages.ts
import type { MoveInput, PlayerState } from "./prediction.js";

const PROTOCOL_VERSION = 1;

// Stable numeric message tags; never reuse a value across versions.
const KIND_INPUTS = 1;
const KIND_SNAPSHOT = 2;
const KIND_BOOTSTRAP = 3;
const KIND_BOOTSTRAP_ACK = 4;

const MAX_INPUTS = 8;
const MOVE_SCALE = 32_767;

// Positions feed back into the local simulation, so quantize on a fine grid: 1024 steps per world
// unit (~0.001 units) over a fixed [-2048, 2048] world, encoded as int32.
const POS_MIN = -2048;
const POS_MAX = 2048;
const POS_SCALE = 1024;
const POS_QUANT_MIN = POS_MIN * POS_SCALE;
const POS_QUANT_MAX = POS_MAX * POS_SCALE;

// ackInputSeq is -1 until the authority processes an input; reserve the top uint32 as that sentinel.
const ACK_NONE_WIRE = 0xffff_ffff;
const MAX_ACK_SEQ = 0xffff_fffe;

const MAX_USER_ID_BYTES = 64;

// Little-endian layout sizes.
const INPUT_HEADER_BYTES = 3; // version u8, kind u8, count u8
const INPUT_RECORD_BYTES = 8; // seq u32, moveX i16, moveY i16
const SNAPSHOT_BODY_BYTES = 20; // tick u32, playerId u32, x i32, y i32, ackInputSeq u32
const SNAPSHOT_BYTES = 2 + SNAPSHOT_BODY_BYTES;
const BOOTSTRAP_HEADER_BYTES = 6; // version u8, kind u8, bootstrapId u32
const BOOTSTRAP_MIN_BYTES = BOOTSTRAP_HEADER_BYTES + SNAPSHOT_BODY_BYTES + 1; // + userId length + bytes
const BOOTSTRAP_ACK_BYTES = 6; // version u8, kind u8, bootstrapId u32

export type InputPacket = { inputs: MoveInput[] };

export type PlayerSnapshot = PlayerState & {
  playerId: number;
  ackInputSeq: number;
};

export type Snapshot = {
  tick: number;
  player: PlayerSnapshot;
};

export type Bootstrap = {
  bootstrapId: number;
  userId: string;
  snapshot: Snapshot;
};

export type BootstrapAck = { bootstrapId: number };

export function encodeInputPacket(packet: InputPacket): Uint8Array {
  if (packet.inputs.length > MAX_INPUTS) throw new Error("Too many inputs in packet");
  for (const input of packet.inputs) {
    if (
      !Number.isInteger(input.seq) ||
      input.seq < 0 ||
      input.seq > 0xffff_ffff ||
      !Number.isFinite(input.moveX) ||
      !Number.isFinite(input.moveY) ||
      Math.abs(input.moveX) > 1 ||
      Math.abs(input.moveY) > 1
    ) {
      throw new Error("Invalid local input");
    }
  }

  const bytes = new Uint8Array(INPUT_HEADER_BYTES + packet.inputs.length * INPUT_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_INPUTS);
  view.setUint8(2, packet.inputs.length);
  let offset = INPUT_HEADER_BYTES;
  for (const input of packet.inputs) {
    view.setUint32(offset, input.seq, true);
    view.setInt16(offset + 4, Math.round(input.moveX * MOVE_SCALE), true);
    view.setInt16(offset + 6, Math.round(input.moveY * MOVE_SCALE), true);
    offset += INPUT_RECORD_BYTES;
  }
  return bytes;
}

export function decodeInputPacket(bytes: Uint8Array): InputPacket | undefined {
  if (bytes.byteLength < INPUT_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_INPUTS) return undefined;

  const count = view.getUint8(2);
  if (count > MAX_INPUTS) return undefined;
  if (bytes.byteLength !== INPUT_HEADER_BYTES + count * INPUT_RECORD_BYTES) return undefined;

  const inputs: MoveInput[] = [];
  let offset = INPUT_HEADER_BYTES;
  for (let i = 0; i < count; i += 1) {
    const rawMoveX = view.getInt16(offset + 4, true);
    const rawMoveY = view.getInt16(offset + 6, true);
    if (
      rawMoveX < -MOVE_SCALE ||
      rawMoveX > MOVE_SCALE ||
      rawMoveY < -MOVE_SCALE ||
      rawMoveY > MOVE_SCALE
    ) {
      return undefined;
    }
    inputs.push({
      seq: view.getUint32(offset, true),
      moveX: rawMoveX / MOVE_SCALE,
      moveY: rawMoveY / MOVE_SCALE,
    });
    offset += INPUT_RECORD_BYTES;
  }
  return { inputs };
}

export function encodeSnapshot(snapshot: Snapshot): Uint8Array {
  const bytes = new Uint8Array(SNAPSHOT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_SNAPSHOT);
  writeSnapshotBody(view, 2, snapshot);
  return bytes;
}

export function decodeSnapshot(bytes: Uint8Array): Snapshot | undefined {
  if (bytes.byteLength !== SNAPSHOT_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_SNAPSHOT) return undefined;
  return readSnapshotBody(view, 2);
}

export function encodeBootstrap(bootstrap: Bootstrap): Uint8Array {
  if (
    !Number.isInteger(bootstrap.bootstrapId) ||
    bootstrap.bootstrapId < 0 ||
    bootstrap.bootstrapId > 0xffff_ffff
  ) {
    throw new Error("Invalid bootstrapId");
  }
  const userIdBytes = new TextEncoder().encode(bootstrap.userId);
  if (userIdBytes.byteLength > MAX_USER_ID_BYTES) throw new Error("userId too long");

  const bytes = new Uint8Array(BOOTSTRAP_MIN_BYTES + userIdBytes.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_BOOTSTRAP);
  view.setUint32(2, bootstrap.bootstrapId, true);
  writeSnapshotBody(view, BOOTSTRAP_HEADER_BYTES, bootstrap.snapshot);
  view.setUint8(BOOTSTRAP_HEADER_BYTES + SNAPSHOT_BODY_BYTES, userIdBytes.byteLength);
  bytes.set(userIdBytes, BOOTSTRAP_MIN_BYTES);
  return bytes;
}

export function decodeBootstrap(bytes: Uint8Array): Bootstrap | undefined {
  if (bytes.byteLength < BOOTSTRAP_MIN_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_BOOTSTRAP)
    return undefined;

  const bootstrapId = view.getUint32(2, true);
  const snapshot = readSnapshotBody(view, BOOTSTRAP_HEADER_BYTES);
  if (!snapshot) return undefined;

  const userIdLen = view.getUint8(BOOTSTRAP_HEADER_BYTES + SNAPSHOT_BODY_BYTES);
  if (userIdLen > MAX_USER_ID_BYTES) return undefined;
  if (bytes.byteLength !== BOOTSTRAP_MIN_BYTES + userIdLen) return undefined;
  let userId: string;
  try {
    userId = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(BOOTSTRAP_MIN_BYTES, BOOTSTRAP_MIN_BYTES + userIdLen),
    );
  } catch {
    return undefined;
  }
  return { bootstrapId, userId, snapshot };
}

export function encodeBootstrapAck(ack: BootstrapAck): Uint8Array {
  if (!Number.isInteger(ack.bootstrapId) || ack.bootstrapId < 0 || ack.bootstrapId > 0xffff_ffff) {
    throw new Error("Invalid bootstrapId");
  }
  const bytes = new Uint8Array(BOOTSTRAP_ACK_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_BOOTSTRAP_ACK);
  view.setUint32(2, ack.bootstrapId, true);
  return bytes;
}

export function decodeBootstrapAck(bytes: Uint8Array): BootstrapAck | undefined {
  if (bytes.byteLength !== BOOTSTRAP_ACK_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_BOOTSTRAP_ACK) {
    return undefined;
  }
  return { bootstrapId: view.getUint32(2, true) };
}

// One compact formatter for the highest-rate family; it calls the real decoder.
export function formatInputPacketForLog(bytes: Uint8Array): string {
  const packet = decodeInputPacket(bytes);
  if (!packet) return `invalid input packet (${bytes.byteLength} bytes)`;
  const parts = packet.inputs.map(
    (input) => `#${input.seq}(${input.moveX.toFixed(3)},${input.moveY.toFixed(3)})`,
  );
  return `inputs x${packet.inputs.length} [${parts.join(" ")}]`;
}

function writeSnapshotBody(view: DataView, offset: number, snapshot: Snapshot): void {
  const player = snapshot.player;
  if (
    !Number.isInteger(snapshot.tick) ||
    snapshot.tick < 0 ||
    snapshot.tick > 0xffff_ffff ||
    !Number.isInteger(player.playerId) ||
    player.playerId < 0 ||
    player.playerId > 0xffff_ffff ||
    !Number.isFinite(player.x) ||
    !Number.isFinite(player.y) ||
    !isValidAckSeq(player.ackInputSeq)
  ) {
    throw new Error("Invalid local snapshot");
  }
  view.setUint32(offset, snapshot.tick, true);
  view.setUint32(offset + 4, player.playerId, true);
  view.setInt32(offset + 8, quantizePosition(player.x), true);
  view.setInt32(offset + 12, quantizePosition(player.y), true);
  view.setUint32(offset + 16, player.ackInputSeq === -1 ? ACK_NONE_WIRE : player.ackInputSeq, true);
}

function readSnapshotBody(view: DataView, offset: number): Snapshot | undefined {
  const tick = view.getUint32(offset, true);
  const playerId = view.getUint32(offset + 4, true);
  const rawX = view.getInt32(offset + 8, true);
  const rawY = view.getInt32(offset + 12, true);
  const rawAck = view.getUint32(offset + 16, true);
  if (rawX < POS_QUANT_MIN || rawX > POS_QUANT_MAX) return undefined;
  if (rawY < POS_QUANT_MIN || rawY > POS_QUANT_MAX) return undefined;
  const ackInputSeq = rawAck === ACK_NONE_WIRE ? -1 : rawAck;
  return {
    tick,
    player: { playerId, x: rawX / POS_SCALE, y: rawY / POS_SCALE, ackInputSeq },
  };
}

function quantizePosition(value: number): number {
  const clamped = Math.max(POS_MIN, Math.min(POS_MAX, value));
  return Math.round(clamped * POS_SCALE);
}

function isValidAckSeq(ackInputSeq: number): boolean {
  return (
    ackInputSeq === -1 ||
    (Number.isInteger(ackInputSeq) && ackInputSeq >= 0 && ackInputSeq <= MAX_ACK_SEQ)
  );
}
```

## Authoritative Server

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  decodeBootstrapAck,
  decodeInputPacket,
  encodeBootstrap,
  encodeSnapshot,
  type Bootstrap,
  type PlayerSnapshot,
  type Snapshot,
} from "./shared/messages.js";
import { stepPlayer, type MoveInput, type PlayerState } from "./shared/prediction.js";

type Authority = {
  id: number;
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
let nextPlayerId = 0;

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
    const packet = decodeInputPacket(event.bytes);
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
        id: nextPlayerId++,
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

function makeSnapshot(player: Authority): Snapshot {
  const playerSnapshot: PlayerSnapshot = {
    playerId: player.id,
    x: player.state.x,
    y: player.state.y,
    ackInputSeq: player.lastProcessedSeq,
  };
  return { tick, player: playerSnapshot };
}

function sendCorrections(): void {
  for (const connection of server.connections) {
    const player = players.get(connection.userId);
    if (player?.activeConnectionId === connection.id) {
      connection.datagrams.send(encodeSnapshot(makeSnapshot(player)));
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
          bootstrapId: nextBootstrapId++,
          userId: connection.userId,
          snapshot: makeSnapshot(player),
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
    connection.streams.send(encodeBootstrap(pending.message));
    pending.lastSentAtMs = nowMs;
    pending.attempts += 1;
  }
}

function receiveBootstrapAcks(): void {
  for (const event of server.streams.drain()) {
    const ack = decodeBootstrapAck(event.bytes);
    const pending = pendingBootstraps.get(event.connection.id);
    if (ack && pending?.message.bootstrapId === ack.bootstrapId) {
      pending.acknowledged = true;
    }
  }
}
```

Each correction is small and targeted: one 22-byte snapshot datagram. Do not replace it with an
unbounded full-world datagram; remote players belong in independently useful snapshot groups,
deltas, and interest-managed state. To carry many entities per packet with bitpacking, delta
compression against acked baselines, or priority accumulators, see
[`snack-design-binary-protocol`](../../snack-design-binary-protocol/SKILL.md); this example stays at
the byte-aligned `DataView` rung.

## Predicting Client

```ts
// src/client.ts
import { client } from "snack:client";
import {
  decodeBootstrap,
  decodeSnapshot,
  encodeBootstrapAck,
  encodeInputPacket,
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
let localPlayerId = -1;
let lastSnapshotTick = -1;
let previousFrameMs = performance.now();
let accumulatorMs = 0;

async function start(): Promise<void> {
  await client.connection;
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
  void client.datagrams.send(encodeInputPacket(packet)).catch(console.error);
}

function makeInputPacket(inputs: MoveInput[]): InputPacket {
  const selected: MoveInput[] = [];
  for (const input of inputs.slice(-8).reverse()) {
    const candidate: InputPacket = { inputs: [input, ...selected] };
    if (encodedBytes(candidate) > DATAGRAM_BUDGET_BYTES) break;
    selected.unshift(input);
  }
  return { inputs: selected };
}

function encodedBytes(packet: InputPacket): number {
  return encodeInputPacket(packet).byteLength;
}

function reconcile(snapshot: Snapshot): void {
  if (snapshot.tick <= lastSnapshotTick || snapshot.player.playerId !== localPlayerId) return;
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
    const message = decodeBootstrap(event.bytes);
    if (!message) continue;
    localPlayerId = message.snapshot.player.playerId;
    reconcile(message.snapshot);
    const ack: BootstrapAck = { bootstrapId: message.bootstrapId };
    await client.streams.send(encodeBootstrapAck(ack));
  }
}

function frame(nowMs: number): void {
  for (const event of client.datagrams.drain()) {
    const snapshot = decodeSnapshot(event.bytes);
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
