# Authoritative Snapshot Groups And Interpolation

This example uses datagrams for input and independently useful snapshot groups, a retried reliable
bootstrap, and a monotonic render clock that advances between packet arrivals. Every message family
is a binary codec built from the first implementation, not a JSON wire format.

## Shared Protocol

```ts
// src/shared/messages.ts
export type InputMessage = {
  seq: number;
  moveX: number;
  moveY: number;
};

// The wire body a snapshot carries; identity lives in the numeric groupId, not here.
export type PlayerBody = { generation: number; x: number; y: number };

// A fully identified player, resolved on the client from the bootstrap mapping.
export type PlayerSnapshot = { userId: string; generation: number; x: number; y: number };

export type SnapshotGroup = {
  tick: number;
  serverTimeMs: number;
  groupId: number;
  player: PlayerBody | null;
};

export type BootstrapGroup = {
  groupId: number;
  userId: string;
  tick: number;
  serverTimeMs: number;
  body: PlayerBody;
};

export type Bootstrap = { bootstrapId: number; groups: BootstrapGroup[] };

export type BootstrapAck = { bootstrapId: number };

// Reliable identity enrichment: a late joiner learns a groupId -> userId mapping that its own
// bootstrap could not carry because the player activated after the bootstrap was built.
export type GroupIdentity = { groupId: number; generation: number; userId: string };

const PROTOCOL_VERSION = 1;
const KIND_INPUT = 1;
const KIND_SNAPSHOT_GROUP = 2;
const KIND_BOOTSTRAP = 3;
const KIND_BOOTSTRAP_ACK = 4;
const KIND_GROUP_IDENTITY = 5;

const MOVE_SCALE = 32_767;
// Presentation-only positions quantize onto a 1/16 m (~6.25 cm) grid over a +/-2047 m world.
// The widest step is 2047 * 16 = 32752, which stays inside int16.
const WORLD_MIN = -2047;
const WORLD_MAX = 2047;
const POSITION_SCALE = 16;
const POSITION_MIN_STEP = WORLD_MIN * POSITION_SCALE;
const POSITION_MAX_STEP = WORLD_MAX * POSITION_SCALE;

const MAX_BOOTSTRAP_GROUPS = 256;
const USER_ID_MAX_BYTES = 128;

const INPUT_BYTES = 10;
const SNAPSHOT_GROUP_HEADER_BYTES = 13;
const SNAPSHOT_GROUP_PRESENT_BYTES = SNAPSHOT_GROUP_HEADER_BYTES + 8;
const BOOTSTRAP_HEADER_BYTES = 8;
const BOOTSTRAP_ACK_BYTES = 6;
// version + kind + groupId(2) + generation(4) + userIdLen(1), then the length-prefixed userId.
const GROUP_IDENTITY_HEADER_BYTES = 9;

function isUint16(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isValidBody(body: PlayerBody): boolean {
  return isUint32(body.generation) && Number.isFinite(body.x) && Number.isFinite(body.y);
}

function quantizePosition(value: number): number {
  const clamped = Math.min(WORLD_MAX, Math.max(WORLD_MIN, value));
  return Math.round(clamped * POSITION_SCALE);
}

function withinPositionRange(step: number): boolean {
  return step >= POSITION_MIN_STEP && step <= POSITION_MAX_STEP;
}

export function encodeInput(message: InputMessage): Uint8Array {
  if (
    !isUint32(message.seq) ||
    !Number.isFinite(message.moveX) ||
    !Number.isFinite(message.moveY) ||
    Math.abs(message.moveX) > 1 ||
    Math.abs(message.moveY) > 1
  ) {
    throw new Error("Invalid local input message");
  }
  const bytes = new Uint8Array(INPUT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_INPUT);
  view.setUint32(2, message.seq, true);
  view.setInt16(6, Math.round(message.moveX * MOVE_SCALE), true);
  view.setInt16(8, Math.round(message.moveY * MOVE_SCALE), true);
  return bytes;
}

export function decodeInput(bytes: Uint8Array): InputMessage | undefined {
  if (bytes.byteLength !== INPUT_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_INPUT) return undefined;
  const rawMoveX = view.getInt16(6, true);
  const rawMoveY = view.getInt16(8, true);
  if (rawMoveX < -MOVE_SCALE || rawMoveX > MOVE_SCALE) return undefined;
  if (rawMoveY < -MOVE_SCALE || rawMoveY > MOVE_SCALE) return undefined;
  return {
    seq: view.getUint32(2, true),
    moveX: rawMoveX / MOVE_SCALE,
    moveY: rawMoveY / MOVE_SCALE,
  };
}

export function encodeSnapshotGroup(group: SnapshotGroup): Uint8Array {
  if (!isUint32(group.tick) || !isUint32(group.serverTimeMs) || !isUint16(group.groupId)) {
    throw new Error("Invalid local snapshot group");
  }
  const present = group.player !== null;
  if (present && !isValidBody(group.player as PlayerBody)) {
    throw new Error("Invalid local snapshot body");
  }
  const bytes = new Uint8Array(
    present ? SNAPSHOT_GROUP_PRESENT_BYTES : SNAPSHOT_GROUP_HEADER_BYTES,
  );
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_SNAPSHOT_GROUP);
  view.setUint32(2, group.tick, true);
  view.setUint32(6, group.serverTimeMs, true);
  view.setUint16(10, group.groupId, true);
  view.setUint8(12, present ? 1 : 0);
  if (present) {
    const body = group.player as PlayerBody;
    view.setUint32(13, body.generation, true);
    view.setInt16(17, quantizePosition(body.x), true);
    view.setInt16(19, quantizePosition(body.y), true);
  }
  return bytes;
}

export function decodeSnapshotGroup(bytes: Uint8Array): SnapshotGroup | undefined {
  if (bytes.byteLength < SNAPSHOT_GROUP_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_SNAPSHOT_GROUP) {
    return undefined;
  }
  const presence = view.getUint8(12);
  const tick = view.getUint32(2, true);
  const serverTimeMs = view.getUint32(6, true);
  const groupId = view.getUint16(10, true);
  if (presence === 0) {
    if (bytes.byteLength !== SNAPSHOT_GROUP_HEADER_BYTES) return undefined;
    return { tick, serverTimeMs, groupId, player: null };
  }
  if (presence !== 1 || bytes.byteLength !== SNAPSHOT_GROUP_PRESENT_BYTES) return undefined;
  const rawX = view.getInt16(17, true);
  const rawY = view.getInt16(19, true);
  if (!withinPositionRange(rawX) || !withinPositionRange(rawY)) return undefined;
  return {
    tick,
    serverTimeMs,
    groupId,
    player: {
      generation: view.getUint32(13, true),
      x: rawX / POSITION_SCALE,
      y: rawY / POSITION_SCALE,
    },
  };
}

export function encodeBootstrap(message: Bootstrap): Uint8Array {
  if (!isUint32(message.bootstrapId) || message.groups.length > MAX_BOOTSTRAP_GROUPS) {
    throw new Error("Invalid local bootstrap");
  }
  const encoder = new TextEncoder();
  const encoded = message.groups.map((group) => {
    if (
      !isUint16(group.groupId) ||
      !isUint32(group.tick) ||
      !isUint32(group.serverTimeMs) ||
      !isValidBody(group.body)
    ) {
      throw new Error("Invalid local bootstrap group");
    }
    const userIdBytes = encoder.encode(group.userId);
    if (userIdBytes.byteLength > USER_ID_MAX_BYTES) throw new Error("Bootstrap userId exceeds cap");
    return { group, userIdBytes };
  });

  let total = BOOTSTRAP_HEADER_BYTES;
  for (const { userIdBytes } of encoded) total += 3 + userIdBytes.byteLength + 16;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_BOOTSTRAP);
  view.setUint32(2, message.bootstrapId, true);
  view.setUint16(6, message.groups.length, true);

  let offset = BOOTSTRAP_HEADER_BYTES;
  for (const { group, userIdBytes } of encoded) {
    view.setUint16(offset, group.groupId, true);
    offset += 2;
    view.setUint8(offset, userIdBytes.byteLength);
    offset += 1;
    bytes.set(userIdBytes, offset);
    offset += userIdBytes.byteLength;
    view.setUint32(offset, group.body.generation, true);
    offset += 4;
    view.setUint32(offset, group.tick, true);
    offset += 4;
    view.setUint32(offset, group.serverTimeMs, true);
    offset += 4;
    view.setInt16(offset, quantizePosition(group.body.x), true);
    offset += 2;
    view.setInt16(offset, quantizePosition(group.body.y), true);
    offset += 2;
  }
  return bytes;
}

export function decodeBootstrap(bytes: Uint8Array): Bootstrap | undefined {
  if (bytes.byteLength < BOOTSTRAP_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_BOOTSTRAP)
    return undefined;
  const bootstrapId = view.getUint32(2, true);
  const count = view.getUint16(6, true);
  if (count > MAX_BOOTSTRAP_GROUPS) return undefined;

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const groups: BootstrapGroup[] = [];
  const seen = new Set<number>();
  let offset = BOOTSTRAP_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    if (offset + 3 > bytes.byteLength) return undefined;
    const groupId = view.getUint16(offset, true);
    offset += 2;
    const userIdLen = view.getUint8(offset);
    offset += 1;
    if (userIdLen > USER_ID_MAX_BYTES) return undefined;
    if (offset + userIdLen + 16 > bytes.byteLength) return undefined;
    let userId: string;
    try {
      userId = decoder.decode(bytes.subarray(offset, offset + userIdLen));
    } catch {
      return undefined;
    }
    offset += userIdLen;
    const generation = view.getUint32(offset, true);
    offset += 4;
    const tick = view.getUint32(offset, true);
    offset += 4;
    const serverTimeMs = view.getUint32(offset, true);
    offset += 4;
    const rawX = view.getInt16(offset, true);
    offset += 2;
    const rawY = view.getInt16(offset, true);
    offset += 2;
    if (!withinPositionRange(rawX) || !withinPositionRange(rawY)) return undefined;
    if (seen.has(groupId)) return undefined;
    seen.add(groupId);
    groups.push({
      groupId,
      userId,
      tick,
      serverTimeMs,
      body: { generation, x: rawX / POSITION_SCALE, y: rawY / POSITION_SCALE },
    });
  }
  if (offset !== bytes.byteLength) return undefined;
  return { bootstrapId, groups };
}

export function encodeBootstrapAck(message: BootstrapAck): Uint8Array {
  if (!isUint32(message.bootstrapId)) throw new Error("Invalid local bootstrap ack");
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
  return { bootstrapId: view.getUint32(2, true) };
}

export function encodeGroupIdentity(message: GroupIdentity): Uint8Array {
  if (!isUint16(message.groupId) || !isUint32(message.generation)) {
    throw new Error("Invalid local group identity");
  }
  const userIdBytes = new TextEncoder().encode(message.userId);
  if (userIdBytes.byteLength > USER_ID_MAX_BYTES) throw new Error("Identity userId exceeds cap");
  const bytes = new Uint8Array(GROUP_IDENTITY_HEADER_BYTES + userIdBytes.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_GROUP_IDENTITY);
  view.setUint16(2, message.groupId, true);
  view.setUint32(4, message.generation, true);
  view.setUint8(8, userIdBytes.byteLength);
  bytes.set(userIdBytes, GROUP_IDENTITY_HEADER_BYTES);
  return bytes;
}

export function decodeGroupIdentity(bytes: Uint8Array): GroupIdentity | undefined {
  if (bytes.byteLength < GROUP_IDENTITY_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_GROUP_IDENTITY) {
    return undefined;
  }
  const groupId = view.getUint16(2, true);
  const generation = view.getUint32(4, true);
  const userIdLen = view.getUint8(8);
  if (userIdLen > USER_ID_MAX_BYTES) return undefined;
  if (GROUP_IDENTITY_HEADER_BYTES + userIdLen !== bytes.byteLength) return undefined;
  let userId: string;
  try {
    userId = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(GROUP_IDENTITY_HEADER_BYTES, GROUP_IDENTITY_HEADER_BYTES + userIdLen),
    );
  } catch {
    return undefined;
  }
  return { groupId, generation, userId };
}

export function formatSnapshotGroupForLog(bytes: Uint8Array): string {
  const group = decodeSnapshotGroup(bytes);
  if (!group) return `invalid snapshot-group packet (${bytes.byteLength} bytes)`;
  return group.player
    ? `snapshot-group tick=${group.tick} t=${group.serverTimeMs}ms group=${group.groupId} ` +
        `gen=${group.player.generation} pos=(${group.player.x.toFixed(2)},${group.player.y.toFixed(2)})`
    : `snapshot-group tick=${group.tick} t=${group.serverTimeMs}ms group=${group.groupId} tombstone`;
}
```

Every packet is little-endian and opens with a `version` byte and a stable numeric `kind` tag. Local
encoders throw on invalid local state; remote decoders return `undefined` for any malformed,
truncated, wrong-version, out-of-range, over-cap, or trailing-garbage packet, so a bad datagram
never reaches the authoritative loop. Snapshot groups travel as datagrams keyed by a compact
numeric `groupId` the server assigns per player, so the string `userId` never rides the hot path;
the reliable bootstrap carries the `groupId` to `userId` mapping once, length-prefixed and capped,
so the client can still label players. A separate reliable `group-identity` message re-sends one
`groupId` to `userId` mapping (with the player's generation) whenever a player activates, so a
client that already consumed its bootstrap still learns players who join later. Tombstones set the
presence byte to `0` and carry no body. Positions quantize onto a 1/16 m (~6.25 cm) grid over a
+/-2047 m world, which is ample for presentation-only
interpolation, and move axes quantize to `int16` exactly like the shared input codec.
`formatSnapshotGroupForLog` decodes real bytes so packet logs stay readable without a second parser.

## Authoritative Server Loop

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  decodeBootstrapAck,
  decodeInput,
  encodeBootstrap,
  encodeGroupIdentity,
  encodeSnapshotGroup,
  type Bootstrap,
  type BootstrapGroup,
  type PlayerBody,
  type PlayerSnapshot,
} from "./shared/messages.js";

type PlayerState = PlayerSnapshot & {
  activeConnectionId: string | null;
  inputX: number;
  inputY: number;
  lastInputSeq: number;
  lastInputAtMs: number;
};

type OutgoingGroup = {
  tick: number;
  serverTimeMs: number;
  groupId: number;
  userId: string;
  body: PlayerBody | null;
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
const groupIdByUser = new Map<string, number>();
const freeGroupIds: number[] = [];
let tick = 0;
let lastTimeMs = 0;
let nextBootstrapId = 0;
let nextGeneration = 1;
let nextGroupId = 1;

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
        const bytes = encodeSnapshotGroup({
          tick: group.tick,
          serverTimeMs: group.serverTimeMs,
          groupId: group.groupId,
          player: group.body,
        });
        if (bytes.byteLength <= DATAGRAM_BUDGET_BYTES) {
          if (readyConnectionIds.length > 0) {
            server.datagrams.broadcast(bytes, { only: readyConnectionIds });
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
    const input = decodeInput(event.bytes);
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
    const ack = decodeBootstrapAck(event.bytes);
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
  broadcastIdentity(connection.userId);
}

// Reliable, idempotent enrichment: an already-bootstrapped client never saw this player in its own
// bootstrap, so it would withhold the player forever without this. Broadcast on streams to every
// connection with no ack/retry machinery; last-generation-wins on the client keeps it order-free.
function broadcastIdentity(userId: string): void {
  const player = players.get(userId);
  if (!player) return;
  server.streams.broadcast(
    encodeGroupIdentity({
      groupId: groupIdForUser(userId),
      generation: player.generation,
      userId,
    }),
  );
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

function makeSnapshotGroups(serverTimeMs: number): OutgoingGroup[] {
  const groups = [...players.values()].map(({ userId, generation, x, y }) =>
    outgoingGroup(serverTimeMs, userId, { generation, x, y }),
  );
  for (const [userId, expiresAtTick] of tombstones) {
    if (tick > expiresAtTick) {
      tombstones.delete(userId);
      const groupId = groupIdByUser.get(userId);
      if (groupId !== undefined) {
        groupIdByUser.delete(userId);
        freeGroupIds.push(groupId);
      }
    } else if (!players.has(userId)) {
      groups.push(outgoingGroup(serverTimeMs, userId, null));
    }
  }
  return groups;
}

function outgoingGroup(
  serverTimeMs: number,
  userId: string,
  body: PlayerBody | null,
): OutgoingGroup {
  return { tick, serverTimeMs, groupId: groupIdForUser(userId), userId, body };
}

// One stable numeric id per user while present or represented by a tombstone. Recycle ids only
// after tombstone expiry so delayed packets cannot alias a newly joined player.
function groupIdForUser(userId: string): number {
  let id = groupIdByUser.get(userId);
  if (id === undefined) {
    id = freeGroupIds.pop();
    if (id === undefined) {
      if (nextGroupId > 0xffff) throw new Error("exhausted snapshot group id space");
      id = nextGroupId++;
    }
    groupIdByUser.set(userId, id);
  }
  return id;
}

function bootstrapGroups(groups: OutgoingGroup[]): BootstrapGroup[] {
  const result: BootstrapGroup[] = [];
  for (const group of groups) {
    if (group.body === null) continue;
    result.push({
      groupId: group.groupId,
      userId: group.userId,
      tick: group.tick,
      serverTimeMs: group.serverTimeMs,
      body: group.body,
    });
  }
  return result;
}

function sendBootstraps(groups: OutgoingGroup[]): void {
  const nowMs = server.elapsedMs();
  const activeByUser = newestConnectionByUser();
  for (const connection of server.connections) {
    if (activeByUser.get(connection.userId)?.id !== connection.id) continue;
    let pending = pendingBootstraps.get(connection.id);
    if (!pending) {
      pending = {
        message: {
          bootstrapId: nextBootstrapId++,
          groups: bootstrapGroups(groups),
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
    connection.streams.send(encodeBootstrap(pending.message));
    pending.lastSentAtMs = nowMs;
    pending.attempts += 1;
  }
}
```

Each per-player group now carries a compact numeric `groupId` assigned by the server plus a
generation, and disconnect tombstones repeat for several snapshot intervals as a presence flag with
no body. A group can advance even when another group is lost. `bootstrapId` is a plain `uint32`
counter that is unique per bootstrap without the old `connectionId` prefix, because each ack is
matched against the sending connection's pending bootstrap. `activatePlayer` broadcasts a reliable
`group-identity` message on every activation so already-bootstrapped peers learn late joiners; it
needs no ack or retry because a client misses nothing: its own bootstrap already carried every
mapping that existed when it was built, and every later activation triggers a fresh broadcast.
Streams are unordered, so the only hole would be a stale identity overwriting a newer mapping; the
client closes it by keying identity application on the generation and keeping last-generation-wins,
and the retried bootstrap already re-includes current mappings for anything a broadcast raced. Large
worlds that outgrow byte-aligned
per-entity datagrams should move to quantization grids, delta compression against acked baselines,
and priority accumulators; see
[`snack-design-binary-protocol`](../../snack-design-binary-protocol/SKILL.md).

## Shared Interpolation Timing

```ts
// src/shared/interpolation.ts
import type { SnapshotGroup } from "./messages.js";

export type ReceivedGroup = { group: SnapshotGroup; receivedAtMs: number };

export const GROUP_HEALTH_TIMEOUT_MS = 250;

export function pruneUnhealthyGroups(histories: Map<number, ReceivedGroup[]>, nowMs: number): void {
  for (const [groupId, history] of histories) {
    if (nowMs - (history.at(-1)?.receivedAtMs ?? -Infinity) > GROUP_HEALTH_TIMEOUT_MS) {
      histories.delete(groupId);
    }
  }
}

export function nextCommonRenderTimeMs(
  currentTimeMs: number,
  candidateTimeMs: number,
  histories: Map<number, ReceivedGroup[]>,
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
  decodeBootstrap,
  decodeGroupIdentity,
  decodeSnapshotGroup,
  encodeBootstrapAck,
  encodeInput,
  type InputMessage,
  type PlayerBody,
  type PlayerSnapshot,
  type SnapshotGroup,
} from "./shared/messages.js";
import {
  nextCommonRenderTimeMs,
  pruneUnhealthyGroups,
  type ReceivedGroup,
} from "./shared/interpolation.js";

type SampledGroup = { renderTick: number; newestTick: number; groupId: number; body: PlayerBody };
type RenderedSnapshot = { renderTick: number; players: PlayerSnapshot[] };

const histories = new Map<number, ReceivedGroup[]>();
const latestGroupTicks = new Map<number, number>();
const userIdByGroupId = new Map<number, string>();
const identityGenerationByGroupId = new Map<number, number>();
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
  const input: InputMessage = { seq: inputSeq++, moveX, moveY };
  await client.datagrams.send(encodeInput(input));
}

export function getRenderedServerTick(): number {
  return renderedServerTick;
}

// Stream messages are unordered, so identity is last-generation-wins and idempotent: a stale
// message can never clobber a newer mapping, and re-applying the same mapping is a no-op.
function applyIdentity(groupId: number, generation: number, userId: string): void {
  const known = identityGenerationByGroupId.get(groupId);
  if (known !== undefined && known > generation) return;
  identityGenerationByGroupId.set(groupId, generation);
  userIdByGroupId.set(groupId, userId);
}

function pushGroup(group: SnapshotGroup, receivedAtMs: number): void {
  const latestTick = latestGroupTicks.get(group.groupId) ?? -1;
  if (group.tick <= latestTick) return;
  latestGroupTicks.set(group.groupId, group.tick);
  if (!group.player) {
    histories.delete(group.groupId);
    // Drop the identity mapping with the history so churn cannot grow the maps unbounded; a rejoin
    // re-establishes it via a fresh bootstrap or identity broadcast.
    userIdByGroupId.delete(group.groupId);
    identityGenerationByGroupId.delete(group.groupId);
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
    const bootstrap = decodeBootstrap(event.bytes);
    if (bootstrap) {
      for (const group of bootstrap.groups) {
        applyIdentity(group.groupId, group.body.generation, group.userId);
        pushGroup(
          {
            tick: group.tick,
            serverTimeMs: group.serverTimeMs,
            groupId: group.groupId,
            player: group.body,
          },
          performance.now(),
        );
      }
      await client.streams.send(encodeBootstrapAck({ bootstrapId: bootstrap.bootstrapId }));
      continue;
    }
    const identity = decodeGroupIdentity(event.bytes);
    if (identity) applyIdentity(identity.groupId, identity.generation, identity.userId);
  }
}

function frame(nowMs: number): void {
  for (const event of client.datagrams.drain()) {
    const group = decodeSnapshotGroup(event.bytes);
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

  const byUser = new Map<string, PlayerSnapshot>();
  for (const sampled of sampledGroups) {
    const userId = userIdByGroupId.get(sampled.groupId);
    if (userId === undefined) continue;
    byUser.set(userId, {
      userId,
      generation: sampled.body.generation,
      x: sampled.body.x,
      y: sampled.body.y,
    });
  }
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
    groupId: newest.group.groupId,
    body: {
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

void receiveReliableMessages();
requestAnimationFrame(frame);
```

The maximum observed server/local clock offset never decreases, and `renderServerTimeMs` is
monotonic. A larger jitter delay can temporarily hold presentation instead of moving it backward.
Groups that stop updating are hidden within 250 ms so one unhealthy group cannot freeze the common
view tick beyond the lag-compensation history window. Feed `getRenderedServerTick()` into
lag-compensated fire intent when [lag compensation](lag-compensation.md) is selected.

The interpolation buffers key on the numeric `groupId`, and `userIdByGroupId` supplies the human
identity from the bootstrap plus reliable `group-identity` messages. A snapshot whose `groupId`
has no mapping yet still drives the render clock and health pruning; it is only withheld from the
rendered player list until its mapping arrives. The bootstrap covers everyone present when it was
built, and the `group-identity` broadcast fills in players who activate later, so a late joiner is
never withheld forever; `applyIdentity` is generation-keyed and last-wins so unordered stream
delivery cannot clobber a newer mapping, and the tombstone path drops the mapping so the maps
cannot grow across churn. This standalone client owns both receive queues. Merge additional
message parsers into these owners instead of starting another iterator or drain loop.
