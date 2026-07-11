# Deterministic Rollback With Jitter-Buffered Presentation

This example implements the input-frame streaming shape of [rollback](rollback.md): integer
positions, authoritative input frames, bounded datagram bundles, reliable checkpoints, and delayed
interpolation for remote presentation. It demonstrates the rollback core, not a complete game. A
physics game whose full state fits the datagram budget should prefer the simpler full-state
snapshot shape described in [rollback](rollback.md), with `jolt-ts` supplying the deterministic
simulation (see `snack-3d-physics`).

## Deterministic Shared Simulation

```ts
// src/shared/simulation.ts
export type Move = -1 | 0 | 1;

export type InputFrame = {
  tick: number;
  moves: Record<string, Move>;
};

export type SimState = {
  tick: number;
  positionsMm: Record<string, number>;
  rngState: number;
};

export function step(state: SimState, frame: InputFrame): SimState {
  if (frame.tick !== state.tick + 1) {
    throw new Error("input frame tick must follow state tick");
  }

  const positionsMm = { ...state.positionsMm };
  for (const userId of Object.keys(positionsMm).sort()) {
    positionsMm[userId] = (positionsMm[userId] ?? 0) + (frame.moves[userId] ?? 0) * 80;
  }
  return { tick: frame.tick, positionsMm, rngState: nextRng(state.rngState) };
}

export function nextRng(state: number): number {
  let value = state | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value | 0;
}

export function hashState(state: SimState): string {
  const players = Object.entries(state.positionsMm).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return JSON.stringify([state.tick, state.rngState, players]);
}

export function cloneState(state: SimState): SimState {
  return {
    tick: state.tick,
    positionsMm: { ...state.positionsMm },
    rngState: state.rngState,
  };
}
```

Code-unit ordering from `sort()` is deterministic across locales. Do not use locale-dependent
sorting inside a replayable step or state hash.

## Binary Protocol And Runtime Validation

Gameplay messages are binary from the first implementation, not a JSON wire that would later have
to be ripped out. This example stays on rung 2 of the ladder — byte-aligned `DataView` fields —
which is already 5–10x smaller than JSON and plenty for a small rollback peer set. It deliberately
does not bitpack, delta against acked baselines, or prioritize; when the closing prose talks about
scaling past one packet, that work lives in
[`snack-design-binary-protocol`](../../snack-design-binary-protocol/SKILL.md).

Four families. Two travel on datagrams and must fit ~1,000 bytes: `input-bundle` (client → server,
the highest-rate family) and `frame-bundle` (server → client). Two travel on the reliable stream:
`checkpoint` and `bootstrap-ack`. Every packet opens with `version:uint8` then a stable `kind:uint8`
tag; everything is little-endian.

Identity is the one forced change. Datagrams carry a server-assigned `uint16` playerId, never a
userId string; the reliable checkpoint carries the playerId ↔ userId roster so the client can
translate authoritative frames back into the userId-keyed frames the simulation and rollback core
already use. Nothing in `simulation.ts` or `rollback.ts` changes — numeric ids exist only at the
encode/decode boundary. Positions are already exact integer millimetres, so there is no lossy
quantization here at all; moves are the discrete `{-1, 0, 1}` set, encoded as one tag byte rather
than an analog `MOVE_SCALE` int16.

```ts
// src/shared/messages.ts
import type { InputFrame, Move, SimState } from "./simulation.js";

// Little-endian binary wire protocol. Every packet starts with version:uint8 then kind:uint8.
// Gameplay identity on datagrams is a server-assigned uint16 playerId, never a string; the reliable
// checkpoint stream carries the playerId <-> userId roster. Simulation and rollback storage stay
// keyed by userId, so numeric ids only exist at the encode/decode boundary.
const PROTOCOL_VERSION = 1;
const KIND_INPUT_BUNDLE = 1;
const KIND_FRAME_BUNDLE = 2;
const KIND_CHECKPOINT = 3;
const KIND_BOOTSTRAP_ACK = 4;

const MAX_BUNDLE_ENTRIES = 8; // inputs per input-bundle, frames per frame-bundle
const MAX_PLAYERS = 64; // hard cap on players per frame and per checkpoint roster
const MAX_USERID_BYTES = 64; // length-prefixed UTF-8 userId cap (stream only)
const MAX_HASH_BYTES = 8192; // length-prefixed UTF-8 checkpoint-hash cap (stream only)

// Positions are already exact integer millimetres (the sim only adds +/-80 mm per tick), so there is
// no lossy quantization anywhere here: 1 mm precision, int32 field, +/-1000 km validation bound set
// generously so a long session never trips it. Moves are the discrete set {-1, 0, 1}, encoded as a
// single tag byte (move + 1), not an analog MOVE_SCALE int16.
const WORLD_MIN_MM = -1_000_000_000;
const WORLD_MAX_MM = 1_000_000_000;

export type LocalInput = { tick: number; move: Move };
export type InputBundle = { inputs: LocalInput[] };
export type WireMove = { playerId: number; move: Move };
export type WireFrame = { tick: number; moves: WireMove[] };
export type FrameBundle = { frames: WireFrame[] };
export type RosterEntry = { playerId: number; userId: string };
export type Checkpoint = {
  checkpointId: number; // 0 means a periodic checkpoint that needs no ack
  state: SimState;
  hash: string;
  roster: RosterEntry[];
};
export type BootstrapAck = { checkpointId: number };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function moveToTag(move: Move): number {
  return move + 1; // -1,0,1 -> 0,1,2
}

function tagToMove(tag: number): Move | undefined {
  return tag === 0 ? -1 : tag === 1 ? 0 : tag === 2 ? 1 : undefined;
}

// input-bundle (datagram, client -> server): [ver][kind][count] then count * (tick:u32, move:u8).
export function encodeInputBundle(inputs: LocalInput[]): Uint8Array {
  if (inputs.length > MAX_BUNDLE_ENTRIES) throw new Error("input-bundle exceeds entry cap");
  for (const input of inputs) {
    if (!isUint32(input.tick)) throw new Error("input tick out of range");
    if (input.move !== -1 && input.move !== 0 && input.move !== 1) throw new Error("invalid move");
  }
  const bytes = new Uint8Array(3 + inputs.length * 5);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint8(offset, PROTOCOL_VERSION);
  offset += 1;
  view.setUint8(offset, KIND_INPUT_BUNDLE);
  offset += 1;
  view.setUint8(offset, inputs.length);
  offset += 1;
  for (const input of inputs) {
    view.setUint32(offset, input.tick, true);
    offset += 4;
    view.setUint8(offset, moveToTag(input.move));
    offset += 1;
  }
  return bytes;
}

export function decodeInputBundle(bytes: Uint8Array): InputBundle | undefined {
  if (bytes.byteLength < 3) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_INPUT_BUNDLE) {
    return undefined;
  }
  const count = view.getUint8(2);
  if (count > MAX_BUNDLE_ENTRIES) return undefined;
  if (bytes.byteLength !== 3 + count * 5) return undefined; // rejects truncated and trailing bytes
  const inputs: LocalInput[] = [];
  let offset = 3;
  for (let index = 0; index < count; index += 1) {
    const tick = view.getUint32(offset, true);
    offset += 4;
    const move = tagToMove(view.getUint8(offset));
    offset += 1;
    if (move === undefined) return undefined;
    inputs.push({ tick, move });
  }
  return { inputs };
}

// frame-bundle (datagram, server -> client; reliable-stream fallback for oversized single frames):
// [ver][kind][frameCount] then each frame: tick:u32, moveCount:u8, moveCount * (playerId:u16, move:u8).
export function encodeFrameBundle(
  frames: InputFrame[],
  playerIdByUser: ReadonlyMap<string, number>,
): Uint8Array {
  if (frames.length > MAX_BUNDLE_ENTRIES) throw new Error("frame-bundle exceeds frame cap");
  let size = 3;
  for (const frame of frames) {
    const count = Object.keys(frame.moves).length;
    if (count > MAX_PLAYERS) throw new Error("frame exceeds player cap");
    size += 5 + count * 3;
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint8(offset, PROTOCOL_VERSION);
  offset += 1;
  view.setUint8(offset, KIND_FRAME_BUNDLE);
  offset += 1;
  view.setUint8(offset, frames.length);
  offset += 1;
  for (const frame of frames) {
    if (!isUint32(frame.tick)) throw new Error("frame tick out of range");
    const userIds = Object.keys(frame.moves).sort(); // deterministic wire ordering
    view.setUint32(offset, frame.tick, true);
    offset += 4;
    view.setUint8(offset, userIds.length);
    offset += 1;
    for (const userId of userIds) {
      const playerId = playerIdByUser.get(userId);
      if (playerId === undefined || playerId < 0 || playerId > 0xffff) {
        throw new Error("missing or invalid playerId for frame user");
      }
      const move = frame.moves[userId];
      if (move !== -1 && move !== 0 && move !== 1) throw new Error("invalid move");
      view.setUint16(offset, playerId, true);
      offset += 2;
      view.setUint8(offset, moveToTag(move));
      offset += 1;
    }
  }
  return bytes;
}

export function decodeFrameBundle(bytes: Uint8Array): FrameBundle | undefined {
  if (bytes.byteLength < 3) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_FRAME_BUNDLE) {
    return undefined;
  }
  const frameCount = view.getUint8(2);
  if (frameCount > MAX_BUNDLE_ENTRIES) return undefined;
  let offset = 3;
  const frames: WireFrame[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    if (offset + 5 > bytes.byteLength) return undefined;
    const tick = view.getUint32(offset, true);
    offset += 4;
    const moveCount = view.getUint8(offset);
    offset += 1;
    if (moveCount > MAX_PLAYERS) return undefined;
    if (offset + moveCount * 3 > bytes.byteLength) return undefined;
    const moves: WireMove[] = [];
    for (let m = 0; m < moveCount; m += 1) {
      const playerId = view.getUint16(offset, true);
      offset += 2;
      const move = tagToMove(view.getUint8(offset));
      offset += 1;
      if (move === undefined) return undefined;
      moves.push({ playerId, move });
    }
    frames.push({ tick, moves });
  }
  if (offset !== bytes.byteLength) return undefined; // reject trailing bytes
  return { frames };
}

// checkpoint (reliable stream, server -> client): [ver][kind][checkpointId:u32][tick:u32]
// [rngState:i32][playerCount:u16] then each player: playerId:u16, positionMm:i32, userIdLen:u8,
// userId bytes; then hashLen:u16, hash bytes. Strings are stream-only and length-prefixed.
export function encodeCheckpoint(
  checkpointId: number,
  state: SimState,
  hash: string,
  playerIdByUser: ReadonlyMap<string, number>,
): Uint8Array {
  if (!isUint32(checkpointId)) throw new Error("checkpointId out of range");
  if (!isUint32(state.tick)) throw new Error("checkpoint tick out of range");
  if (!Number.isInteger(state.rngState)) throw new Error("rngState must be an integer");
  const userIds = Object.keys(state.positionsMm).sort();
  if (userIds.length > MAX_PLAYERS) throw new Error("checkpoint exceeds player cap");
  const hashBytes = textEncoder.encode(hash);
  if (hashBytes.byteLength > MAX_HASH_BYTES) throw new Error("checkpoint hash too long");
  const userIdBytes = userIds.map((userId) => {
    const encoded = textEncoder.encode(userId);
    if (encoded.byteLength > MAX_USERID_BYTES) throw new Error("userId too long");
    return encoded;
  });

  let size = 2 + 4 + 4 + 4 + 2; // header + checkpointId + tick + rngState + playerCount
  for (const encoded of userIdBytes) size += 2 + 4 + 1 + encoded.byteLength;
  size += 2 + hashBytes.byteLength;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint8(offset, PROTOCOL_VERSION);
  offset += 1;
  view.setUint8(offset, KIND_CHECKPOINT);
  offset += 1;
  view.setUint32(offset, checkpointId, true);
  offset += 4;
  view.setUint32(offset, state.tick, true);
  offset += 4;
  view.setInt32(offset, state.rngState | 0, true);
  offset += 4;
  view.setUint16(offset, userIds.length, true);
  offset += 2;
  for (let index = 0; index < userIds.length; index += 1) {
    const userId = userIds[index]!;
    const encoded = userIdBytes[index]!;
    const playerId = playerIdByUser.get(userId);
    if (playerId === undefined || playerId < 0 || playerId > 0xffff) {
      throw new Error("missing or invalid playerId for checkpoint user");
    }
    const position = state.positionsMm[userId];
    if (position === undefined || !Number.isInteger(position)) {
      throw new Error("checkpoint position must be an integer");
    }
    if (position < WORLD_MIN_MM || position > WORLD_MAX_MM) {
      throw new Error("checkpoint position out of world bounds");
    }
    view.setUint16(offset, playerId, true);
    offset += 2;
    view.setInt32(offset, position, true);
    offset += 4;
    view.setUint8(offset, encoded.byteLength);
    offset += 1;
    bytes.set(encoded, offset);
    offset += encoded.byteLength;
  }
  view.setUint16(offset, hashBytes.byteLength, true);
  offset += 2;
  bytes.set(hashBytes, offset);
  offset += hashBytes.byteLength;
  return bytes;
}

export function decodeCheckpoint(bytes: Uint8Array): Checkpoint | undefined {
  if (bytes.byteLength < 16) return undefined; // header + checkpointId + tick + rngState + playerCount
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_CHECKPOINT) {
    return undefined;
  }
  let offset = 2;
  const checkpointId = view.getUint32(offset, true);
  offset += 4;
  const tick = view.getUint32(offset, true);
  offset += 4;
  const rngState = view.getInt32(offset, true);
  offset += 4;
  const playerCount = view.getUint16(offset, true);
  offset += 2;
  if (playerCount > MAX_PLAYERS) return undefined;
  const positionsMm: Record<string, number> = {};
  const roster: RosterEntry[] = [];
  const seenPlayerIds = new Set<number>();
  const seenUserIds = new Set<string>();
  for (let index = 0; index < playerCount; index += 1) {
    if (offset + 7 > bytes.byteLength) return undefined; // playerId:u16 + pos:i32 + len:u8
    const playerId = view.getUint16(offset, true);
    offset += 2;
    const position = view.getInt32(offset, true);
    offset += 4;
    const userIdLen = view.getUint8(offset);
    offset += 1;
    if (userIdLen > MAX_USERID_BYTES) return undefined;
    if (offset + userIdLen > bytes.byteLength) return undefined;
    if (position < WORLD_MIN_MM || position > WORLD_MAX_MM) return undefined;
    const userId = decodeUtf8(bytes.subarray(offset, offset + userIdLen));
    if (userId === undefined || seenPlayerIds.has(playerId) || seenUserIds.has(userId)) {
      return undefined;
    }
    seenPlayerIds.add(playerId);
    seenUserIds.add(userId);
    offset += userIdLen;
    positionsMm[userId] = position;
    roster.push({ playerId, userId });
  }
  if (offset + 2 > bytes.byteLength) return undefined;
  const hashLen = view.getUint16(offset, true);
  offset += 2;
  if (hashLen > MAX_HASH_BYTES) return undefined;
  if (offset + hashLen > bytes.byteLength) return undefined;
  const hash = decodeUtf8(bytes.subarray(offset, offset + hashLen));
  if (hash === undefined) return undefined;
  offset += hashLen;
  if (offset !== bytes.byteLength) return undefined; // reject trailing bytes
  return { checkpointId, state: { tick, positionsMm, rngState }, hash, roster };
}

// bootstrap-ack (reliable stream, client -> server): [ver][kind][checkpointId:u32].
export function encodeBootstrapAck(ack: BootstrapAck): Uint8Array {
  if (!isUint32(ack.checkpointId)) throw new Error("bootstrap-ack checkpointId out of range");
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, KIND_BOOTSTRAP_ACK);
  view.setUint32(2, ack.checkpointId, true);
  return bytes;
}

export function decodeBootstrapAck(bytes: Uint8Array): BootstrapAck | undefined {
  if (bytes.byteLength !== 6) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== KIND_BOOTSTRAP_ACK) {
    return undefined;
  }
  return { checkpointId: view.getUint32(2, true) };
}

// Compact debug formatter for the highest-rate family; it calls the real decoder so logs and the
// wire format cannot drift apart.
export function formatInputBundleForLog(bytes: Uint8Array): string {
  const bundle = decodeInputBundle(bytes);
  if (!bundle) return `invalid input-bundle packet (${bytes.byteLength} bytes)`;
  const entries = bundle.inputs.map((input) => `t${input.tick}:${input.move}`).join(",");
  return `input-bundle n=${bundle.inputs.length} [${entries}]`;
}
```

Local encoders throw on invalid local state before a byte leaves the process; remote decoders never
throw. Each decoder checks length before every read, validates the version and kind tags, caps counts
and string lengths against protocol constants before iterating, range-checks positions and move tags,
and rejects trailing bytes. A tampered userId round-trips harmlessly: it changes the decoded
`positionsMm` keys, so `hashState` no longer matches the transmitted hash and the checkpoint is
rejected as a hash mismatch.

## Authoritative Server Frames

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  decodeBootstrapAck,
  decodeInputBundle,
  encodeCheckpoint,
  encodeFrameBundle,
} from "./shared/messages.js";
import { hashState, step, type InputFrame, type Move, type SimState } from "./shared/simulation.js";

const DATAGRAM_BUDGET_BYTES = 1000;
const pending = new Map<number, Map<string, Move>>();
const recentFrames: InputFrame[] = [];
type PendingCheckpoint = {
  checkpointId: number;
  bytes: Uint8Array;
  lastSentAtMs: number;
  attempts: number;
  acknowledged: boolean;
};
const pendingCheckpoints = new Map<string, PendingCheckpoint>();
const activeConnectionByUser = new Map<string, string>();
const retiredConnectionIds = new Set<string>();
// Wire identity: each userId gets a stable uint16 playerId. Datagrams carry playerIds; the reliable
// checkpoint stream carries the roster. Simulation state stays keyed by userId, so this map only
// crosses the encode boundary. Ids are not recycled within a session (uint16 space).
const playerIdByUser = new Map<string, number>();
const TICK_MS = 1000 / 60;
const MAX_CATCH_UP_STEPS = 4;
const MAX_INPUT_LEAD_TICKS = 50;
const BOOTSTRAP_RETRY_MS = 500;
const MAX_BOOTSTRAP_ATTEMPTS = 20;
let state: SimState = { tick: 0, positionsMm: {}, rngState: 0x12345678 };
let nextCheckpointId = 1; // 0 is reserved on the wire for a periodic checkpoint that needs no ack
let nextPlayerId = 1;

export async function main(): Promise<void> {
  let nextTickMs = server.elapsedMs();
  while (server.running) {
    const membershipChanged = syncPlayers();
    receiveInputs();
    const connectionActivated = receiveBootstrapAcks();
    sendNewConnectionCheckpoints();
    if (membershipChanged || connectionActivated) {
      const readyIds = readyConnectionIds();
      if (readyIds.length > 0) {
        server.streams.broadcast(makeCheckpointBytes(0), { only: readyIds });
      }
    }

    const nowMs = server.elapsedMs();
    let steps = 0;
    while (nowMs >= nextTickMs && steps < MAX_CATCH_UP_STEPS) {
      advanceAuthority();
      nextTickMs += TICK_MS;
      steps += 1;
    }
    if (steps === MAX_CATCH_UP_STEPS && nowMs >= nextTickMs) nextTickMs = nowMs + TICK_MS;
    await server.sleep(Math.max(1, nextTickMs - server.elapsedMs()));
  }
}

function receiveInputs(): void {
  for (const event of server.datagrams.drain()) {
    if (activeConnectionByUser.get(event.connection.userId) !== event.connection.id) continue;
    if (!pendingCheckpoints.get(event.connection.id)?.acknowledged) continue;
    const bundle = decodeInputBundle(event.bytes);
    if (!bundle) continue;
    for (const input of bundle.inputs) {
      if (input.tick <= state.tick || input.tick > state.tick + MAX_INPUT_LEAD_TICKS) continue;
      let byUser = pending.get(input.tick);
      if (!byUser) {
        byUser = new Map();
        pending.set(input.tick, byUser);
      }
      byUser.set(event.connection.userId, input.move);
    }
  }
}

function advanceAuthority(): void {
  const tick = state.tick + 1;
  const submitted = pending.get(tick) ?? new Map<string, Move>();
  const moves: Record<string, Move> = {};
  for (const userId of Object.keys(state.positionsMm).sort()) {
    moves[userId] = submitted.get(userId) ?? 0;
  }
  pending.delete(tick);

  const frame: InputFrame = { tick, moves };
  state = step(state, frame);
  recentFrames.push(frame);
  while (recentFrames.length > 8) recentFrames.shift();

  const selected = boundedFrameBundle(recentFrames);
  const readyIds = readyConnectionIds();
  if (selected.length > 0) {
    if (readyIds.length > 0) {
      server.datagrams.broadcast(encodeFrameBundle(selected, playerIdByUser), { only: readyIds });
    }
  } else {
    // A single full-world frame no longer fits a path-MTU datagram. Preserve correctness reliably;
    // then move up the ladder in `snack-design-binary-protocol` (bitpacking, deltas, priority,
    // interest groups) or redesign with fewer rollback peers.
    if (readyIds.length > 0) {
      server.streams.broadcast(encodeFrameBundle([frame], playerIdByUser), { only: readyIds });
    }
  }

  if (state.tick % 120 === 0 && readyIds.length > 0) {
    server.streams.broadcast(makeCheckpointBytes(0), { only: readyIds });
  }
}

function boundedFrameBundle(frames: InputFrame[]): InputFrame[] {
  let selected: InputFrame[] = [];
  for (const frame of [...frames].reverse()) {
    const candidate = [frame, ...selected];
    if (encodeFrameBundle(candidate, playerIdByUser).byteLength > DATAGRAM_BUDGET_BYTES) break;
    selected = candidate;
  }
  return selected;
}

function makeCheckpointBytes(checkpointId: number): Uint8Array {
  return encodeCheckpoint(checkpointId, state, hashState(state), playerIdByUser);
}

function ensurePlayerId(userId: string): void {
  if (playerIdByUser.has(userId)) return;
  if (nextPlayerId > 0xffff) throw new Error("exhausted uint16 player-id space");
  playerIdByUser.set(userId, nextPlayerId++);
}

function sendNewConnectionCheckpoints(): void {
  const nowMs = server.elapsedMs();
  const newestByUser = newestConnectionByUser();
  for (const connection of server.connections) {
    if (newestByUser.get(connection.userId)?.id !== connection.id) continue;
    let pending = pendingCheckpoints.get(connection.id);
    if (!pending) {
      const checkpointId = nextCheckpointId++;
      pending = {
        checkpointId,
        bytes: makeCheckpointBytes(checkpointId),
        lastSentAtMs: -Infinity,
        attempts: 0,
        acknowledged: false,
      };
      pendingCheckpoints.set(connection.id, pending);
    }
    if (pending.acknowledged) continue;
    if (pending.attempts >= MAX_BOOTSTRAP_ATTEMPTS) {
      retiredConnectionIds.add(connection.id);
      pendingCheckpoints.delete(connection.id);
      continue;
    }
    if (nowMs - pending.lastSentAtMs < BOOTSTRAP_RETRY_MS) continue;
    connection.streams.send(pending.bytes);
    pending.lastSentAtMs = nowMs;
    pending.attempts += 1;
  }
}

function receiveBootstrapAcks(): boolean {
  let activated = false;
  for (const event of server.streams.drain()) {
    const ack = decodeBootstrapAck(event.bytes);
    const pending = pendingCheckpoints.get(event.connection.id);
    if (
      !ack ||
      pending?.checkpointId !== ack.checkpointId ||
      pending.acknowledged ||
      retiredConnectionIds.has(event.connection.id)
    ) {
      continue;
    }
    const newest = newestConnectionByUser().get(event.connection.userId);
    if (newest?.id !== event.connection.id) continue;
    pending.acknowledged = true;
    activeConnectionByUser.set(event.connection.userId, event.connection.id);
    if (state.positionsMm[event.connection.userId] === undefined) {
      state.positionsMm[event.connection.userId] = 0;
    }
    ensurePlayerId(event.connection.userId);
    activated = true;
  }
  return activated;
}

function syncPlayers(): boolean {
  let changed = false;
  const activeByUser = newestConnectionByUser();
  const connectedIds = new Set(server.connections.map((connection) => connection.id));
  for (const connection of server.connections) {
    const newest = activeByUser.get(connection.userId);
    if (newest?.id !== connection.id && !retiredConnectionIds.has(connection.id)) {
      retiredConnectionIds.add(connection.id);
      pendingCheckpoints.delete(connection.id);
    }
  }
  for (const [userId, connection] of activeByUser) {
    const previousConnectionId = activeConnectionByUser.get(userId);
    if (previousConnectionId && previousConnectionId !== connection.id) {
      retiredConnectionIds.add(previousConnectionId);
      pendingCheckpoints.delete(previousConnectionId);
      activeConnectionByUser.delete(userId);
      for (const byUser of pending.values()) byUser.delete(userId);
    }
  }
  for (const userId of Object.keys(state.positionsMm)) {
    if (!activeByUser.has(userId)) {
      delete state.positionsMm[userId];
      activeConnectionByUser.delete(userId);
      playerIdByUser.delete(userId);
      changed = true;
    }
  }
  for (const connectionId of pendingCheckpoints.keys()) {
    if (!connectedIds.has(connectionId)) pendingCheckpoints.delete(connectionId);
  }
  for (const connectionId of retiredConnectionIds) {
    if (!connectedIds.has(connectionId)) retiredConnectionIds.delete(connectionId);
  }
  return changed;
}

function readyConnectionIds(): string[] {
  return [...activeConnectionByUser.values()].filter(
    (connectionId) =>
      !retiredConnectionIds.has(connectionId) &&
      pendingCheckpoints.get(connectionId)?.acknowledged === true,
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
```

This compact sample checkpoints membership changes. A production rollback game should encode
join/leave as explicit deterministic tick events and decide whether one user can own more than one
connection or seat.

## Client Rollback Core

```ts
// src/shared/rollback.ts
import type { InputFrame, Move, SimState } from "./simulation.js";
import { cloneState, hashState, step } from "./simulation.js";

export type CheckpointResult = "reconciled" | "reset" | "stale" | "hash-mismatch";

const stateBeforeTick = new Map<number, SimState>();
const predictedFrames = new Map<number, InputFrame>();
const authoritativeFrames = new Map<number, InputFrame>();
const presentationStates = new Map<number, SimState>();
let state: SimState = { tick: 0, positionsMm: {}, rngState: 0x12345678 };
let localUserId = "";
let latestCheckpointTick = -1;
let ready = false;

export function setLocalUserId(userId: string): void {
  localUserId = userId;
}

export function isRollbackReady(): boolean {
  return ready;
}

export function currentState(): SimState {
  return cloneState(state);
}

export function predictTick(
  localMove: Move,
  predictedRemoteMoves: Record<string, Move>,
): number | undefined {
  if (!ready || !localUserId) return undefined;
  const tick = state.tick + 1;
  const predicted: InputFrame = {
    tick,
    moves: { ...predictedRemoteMoves, [localUserId]: localMove },
  };
  const frame = authoritativeFrames.get(tick) ?? predicted;
  stateBeforeTick.set(tick, cloneState(state));
  predictedFrames.set(tick, frame);
  state = step(state, frame);
  presentationStates.set(state.tick, cloneState(state));
  pruneHistory(state.tick - 240);
  return tick;
}

export function acceptAuthoritativeFrame(frame: InputFrame): void {
  if (frame.tick <= latestCheckpointTick) return;
  authoritativeFrames.set(frame.tick, frame);
  const predicted = predictedFrames.get(frame.tick);
  if (predicted && !sameMoves(predicted.moves, frame.moves)) rollbackFrom(frame.tick);
}

export function applyCheckpoint(checkpoint: SimState, expectedHash: string): CheckpointResult {
  if (checkpoint.tick <= latestCheckpointTick) return "stale";
  if (hashState(checkpoint) !== expectedHash) return "hash-mismatch";

  if (ready && checkpoint.tick <= state.tick) {
    const replayFrames: InputFrame[] = [];
    for (let tick = checkpoint.tick + 1; tick <= state.tick; tick += 1) {
      const frame = authoritativeFrames.get(tick) ?? predictedFrames.get(tick);
      if (!frame) return resetToCheckpoint(checkpoint);
      replayFrames.push(frame);
    }

    const replayStates: SimState[] = [cloneState(checkpoint)];
    let replayed = cloneState(checkpoint);
    for (const frame of replayFrames) {
      replayed = step(replayed, frame);
      replayStates.push(cloneState(replayed));
    }

    state = replayed;
    latestCheckpointTick = checkpoint.tick;
    stateBeforeTick.clear();
    predictedFrames.clear();
    presentationStates.clear();
    presentationStates.set(checkpoint.tick, cloneState(checkpoint));
    for (let index = 0; index < replayFrames.length; index += 1) {
      const frame = replayFrames[index];
      const before = replayStates[index];
      const after = replayStates[index + 1];
      if (!frame || !before || !after) continue;
      stateBeforeTick.set(frame.tick, before);
      predictedFrames.set(frame.tick, frame);
      presentationStates.set(frame.tick, after);
    }
    pruneHistory(state.tick - 240);
    return "reconciled";
  }

  return resetToCheckpoint(checkpoint);
}

function resetToCheckpoint(checkpoint: SimState): CheckpointResult {
  state = cloneState(checkpoint);
  latestCheckpointTick = checkpoint.tick;
  ready = true;
  stateBeforeTick.clear();
  predictedFrames.clear();
  authoritativeFrames.clear();
  presentationStates.clear();
  presentationStates.set(state.tick, cloneState(state));
  return "reset";
}

export function samplePresentation(targetTick: number): Record<string, number> {
  const olderTick = Math.floor(targetTick);
  const newerTick = Math.ceil(targetTick);
  const older = presentationStates.get(olderTick) ?? state;
  const newer = presentationStates.get(newerTick) ?? older;
  const alpha = Math.min(1, Math.max(0, targetTick - olderTick));
  const userIds = new Set([...Object.keys(older.positionsMm), ...Object.keys(newer.positionsMm)]);
  const sampled: Record<string, number> = {};
  for (const userId of userIds) {
    const from = older.positionsMm[userId] ?? newer.positionsMm[userId] ?? 0;
    const to = newer.positionsMm[userId] ?? from;
    sampled[userId] = from + (to - from) * alpha;
  }
  return sampled;
}

function rollbackFrom(firstTick: number): void {
  const restored = stateBeforeTick.get(firstTick);
  if (!restored) {
    console.warn("rollback history exhausted; waiting for a reliable checkpoint");
    return;
  }

  const targetTick = state.tick;
  const replayFrames: InputFrame[] = [];
  for (let tick = firstTick; tick <= targetTick; tick += 1) {
    const frame = authoritativeFrames.get(tick) ?? predictedFrames.get(tick);
    if (!frame) {
      console.warn("rollback frame missing; waiting for a reliable checkpoint");
      return;
    }
    replayFrames.push(frame);
  }

  state = cloneState(restored);
  for (const frame of replayFrames) {
    const tick = frame.tick;
    stateBeforeTick.set(tick, cloneState(state));
    state = step(state, frame);
    predictedFrames.set(tick, frame);
    presentationStates.set(tick, cloneState(state));
  }
}

function pruneHistory(minTick: number): void {
  for (const map of [stateBeforeTick, predictedFrames, authoritativeFrames, presentationStates]) {
    for (const tick of map.keys()) if (tick < minTick) map.delete(tick);
  }
}

function sameMoves(a: Record<string, Move>, b: Record<string, Move>): boolean {
  const userIds = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const userId of userIds) {
    if ((a[userId] ?? 0) !== (b[userId] ?? 0)) return false;
  }
  return true;
}
```

## Snack Client Glue, Jitter Buffer, And Interpolation

```ts
// src/client.ts
import { client } from "snack:client";
import {
  decodeCheckpoint,
  decodeFrameBundle,
  encodeBootstrapAck,
  encodeInputBundle,
  type FrameBundle,
  type LocalInput,
} from "./shared/messages.js";
import {
  acceptAuthoritativeFrame,
  applyCheckpoint,
  currentState,
  isRollbackReady,
  predictTick,
  samplePresentation,
  setLocalUserId,
} from "./shared/rollback.js";
import type { InputFrame, Move } from "./shared/simulation.js";

const STEP_MS = 1000 / 60;
const DATAGRAM_BUDGET_BYTES = 1000;
const MAX_INPUT_LEAD_TICKS = 50;
const MAX_SUPPORTED_RTT_MS = 500;
const unconfirmedInputs: LocalInput[] = [];
// playerId -> userId, merged from every checkpoint's roster. Authoritative frames arrive keyed by
// numeric playerId; this map translates them back to the userId-keyed frames the rollback core uses.
const userByPlayerId = new Map<number, string>();
let localUserId = "";
let previousFrameMs = performance.now();
let accumulatorMs = 0;
let presentationDelayTicks = 3;
let lastDelayUpdateMs = 0;
let appliedInputLeadTicks = 0;
let warnedUnsupportedLatency = false;

async function start(): Promise<void> {
  localUserId = (await client.connection).userId;
  setLocalUserId(localUserId);
  void receiveReliableMessages();
  requestAnimationFrame(frame);
}

function simulateLocalTick(): void {
  if (!inputLeadIsSupported()) return;
  const move = readLocalMove();
  const tick = predictTick(move, {});
  if (tick === undefined) return;
  unconfirmedInputs.push({ tick, move });
  while (unconfirmedInputs.length > 8) unconfirmedInputs.shift();
  void sendInputs().catch(console.error);
}

async function sendInputs(): Promise<void> {
  const inputs = boundedInputBundle(unconfirmedInputs);
  if (inputs.length > 0) await client.datagrams.send(encodeInputBundle(inputs));
}

function boundedInputBundle(inputs: LocalInput[]): LocalInput[] {
  let selected: LocalInput[] = [];
  for (const input of [...inputs].reverse()) {
    const candidate = [input, ...selected];
    if (encodeInputBundle(candidate).byteLength > DATAGRAM_BUDGET_BYTES) break;
    selected = candidate;
  }
  return selected;
}

function receiveAuthoritativeFrames(): void {
  for (const event of client.datagrams.drain()) {
    const bundle = decodeFrameBundle(event.bytes);
    if (bundle) applyFrames(bundle);
  }
}

function applyFrames(bundle: FrameBundle): void {
  for (const wireFrame of bundle.frames) {
    const moves: Record<string, Move> = {};
    for (const wireMove of wireFrame.moves) {
      const userId = userByPlayerId.get(wireMove.playerId);
      // A frame can name a player before its introducing checkpoint arrives; skip and reconcile.
      if (userId === undefined) continue;
      moves[userId] = wireMove.move;
    }
    const frame: InputFrame = { tick: wireFrame.tick, moves };
    acceptAuthoritativeFrame(frame);
    const localMove = moves[localUserId];
    if (localMove !== undefined) {
      const index = unconfirmedInputs.findIndex((input) => input.tick === frame.tick);
      if (index >= 0) unconfirmedInputs.splice(0, index + 1);
    }
  }
}

async function receiveReliableMessages(): Promise<void> {
  for await (const event of client.streams) {
    const bytes = event.bytes;
    const frameBundle = decodeFrameBundle(bytes);
    if (frameBundle) {
      applyFrames(frameBundle);
      continue;
    }
    const checkpoint = decodeCheckpoint(bytes);
    if (!checkpoint) continue;
    for (const entry of checkpoint.roster) userByPlayerId.set(entry.playerId, entry.userId);
    const result = applyCheckpoint(checkpoint.state, checkpoint.hash);
    if (result === "hash-mismatch") {
      console.error("ignored an invalid checkpoint; waiting for the next reliable checkpoint");
      continue;
    }
    if (checkpoint.checkpointId !== 0) {
      await client.streams.send(encodeBootstrapAck({ checkpointId: checkpoint.checkpointId }));
    }
    if (result === "reset") {
      unconfirmedInputs.length = 0;
      fastForwardAfterCheckpoint();
    }
  }
}

function fastForwardAfterCheckpoint(): void {
  // The checkpoint and the next input each spend about half an RTT in flight. Run ahead far enough
  // that newly scheduled input is still inside the server's accepted future-tick window.
  const rttMs = client.net.rtt ?? 100;
  const jitterMs = client.net.jitter ?? 0;
  const leadTicks = desiredInputLeadTicks(rttMs, jitterMs);
  for (let index = 0; index < leadTicks; index += 1) predictTick(0, {});
  appliedInputLeadTicks = leadTicks;
}

function desiredInputLeadTicks(rttMs: number, jitterMs: number): number {
  return Math.min(
    MAX_INPUT_LEAD_TICKS - 2,
    Math.max(2, Math.ceil((rttMs + jitterMs * 2) / STEP_MS)),
  );
}

function ensureInputLead(): void {
  if (!isRollbackReady()) return;
  const desired = desiredInputLeadTicks(client.net.rtt ?? 100, client.net.jitter ?? 0);
  while (appliedInputLeadTicks < desired) {
    predictTick(0, {});
    appliedInputLeadTicks += 1;
  }
}

function inputLeadIsSupported(): boolean {
  const rttMs = client.net.rtt;
  if (rttMs === null) return true;
  const jitterMs = client.net.jitter ?? 0;
  const required = Math.ceil((rttMs + jitterMs * 2) / STEP_MS);
  if (rttMs <= MAX_SUPPORTED_RTT_MS && required <= MAX_INPUT_LEAD_TICKS - 2) return true;
  if (!warnedUnsupportedLatency) {
    warnedUnsupportedLatency = true;
    console.error("rollback input disabled outside the configured RTT/jitter lead window");
  }
  return false;
}

function updatePresentationDelay(nowMs: number): void {
  if (nowMs - lastDelayUpdateMs < 1000) return;
  lastDelayUpdateMs = nowMs;
  const jitterMs = client.net.jitter ?? 0;
  const desired = Math.min(8, Math.max(2, Math.ceil((50 + jitterMs * 2) / STEP_MS)));
  if (desired > presentationDelayTicks) presentationDelayTicks += 1;
  if (desired < presentationDelayTicks) presentationDelayTicks -= 1;
}

function frame(nowMs: number): void {
  receiveAuthoritativeFrames();
  updatePresentationDelay(nowMs);
  ensureInputLead();

  const elapsed = Math.min(100, nowMs - previousFrameMs);
  previousFrameMs = nowMs;
  accumulatorMs += elapsed;
  let steps = 0;
  while (accumulatorMs >= STEP_MS && steps < 5) {
    simulateLocalTick();
    accumulatorMs -= STEP_MS;
    steps += 1;
  }

  if (isRollbackReady()) {
    const current = currentState();
    const targetTick = current.tick - presentationDelayTicks + accumulatorMs / STEP_MS;
    const rendered = samplePresentation(targetTick);
    // Keep local input immediate; delay and interpolate remote players to absorb jitter.
    rendered[localUserId] = current.positionsMm[localUserId] ?? 0;
    renderPlayers(rendered);
  }
  requestAnimationFrame(frame);
}

function readLocalMove(): Move {
  return 0;
}

function renderPlayers(positionsMm: Record<string, number>): void {
  console.log(positionsMm);
}

void start();
```

This standalone client owns both receive queues. Merge additional message parsers into these owners
instead of starting another iterator or drain loop.

The example's matching 50-tick server/client future window targets up to 500 ms RTT plus a bounded
jitter margin. Change the supported RTT, client lead cap, and server acceptance window together;
outside that envelope, enter an explicit degraded state instead of letting every input arrive stale.

The jitter buffer is presentation-only. It changes gradually within two to eight ticks, remote
positions interpolate through saved states, and the local predicted player remains immediate. A
fresh launch gets a new connection and checkpoint; it must not reuse the old page's buffers.

## Shooter Lag Compensation Is Separate

Rollback does not by itself validate a shot against what the shooter saw. A server-authoritative
shooter may also use [lag compensation](lag-compensation.md) to retain a bounded hitbox history and
rewind hit validation by a clamped amount derived from RTT and jitter. Keep damage, ammo, cooldowns,
and the rewind limit authoritative on the server.

## Side Effects

Do not emit irreversible effects directly from `step()`:

- play confirmed audio or particles after the tick is authoritative, or deduplicate by event id
- keep analytics and persistence outside replay
- never double-apply score, inventory, or UI notifications during resimulation
