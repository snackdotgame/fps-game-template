# Deterministic Rollback With Jitter-Buffered Presentation

This example uses integer positions, authoritative input frames, bounded datagram bundles, reliable
checkpoints, and delayed interpolation for remote presentation. It demonstrates the rollback core,
not a complete game.

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

## Protocol And Runtime Validation

```ts
// src/shared/messages.ts
import type { InputFrame, Move, SimState } from "./simulation.js";

export type LocalInput = { tick: number; move: Move };
export type InputBundle = { v: 1; type: "input-bundle"; inputs: LocalInput[] };
export type FrameBundle = { v: 1; type: "frame-bundle"; frames: InputFrame[] };
export type Checkpoint = {
  v: 1;
  type: "checkpoint";
  checkpointId: string | null;
  state: SimState;
  hash: string;
};
export type BootstrapAck = { v: 1; type: "bootstrap-ack"; checkpointId: string };

export function parseInputBundle(value: unknown): InputBundle | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "input-bundle" ||
    !Array.isArray(record.inputs) ||
    record.inputs.length > 8
  ) {
    return undefined;
  }
  const inputs: LocalInput[] = [];
  for (const value of record.inputs) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(input.tick) ||
      (input.move !== -1 && input.move !== 0 && input.move !== 1)
    ) {
      return undefined;
    }
    inputs.push({ tick: input.tick as number, move: input.move });
  }
  return { v: 1, type: "input-bundle", inputs };
}

export function parseFrameBundle(value: unknown): FrameBundle | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "frame-bundle" ||
    !Array.isArray(record.frames) ||
    record.frames.length > 8
  ) {
    return undefined;
  }
  const frames: InputFrame[] = [];
  for (const value of record.frames) {
    const frame = parseFrame(value);
    if (!frame) return undefined;
    frames.push(frame);
  }
  return { v: 1, type: "frame-bundle", frames };
}

export function parseCheckpoint(value: unknown): Checkpoint | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const state = parseState(record.state);
  if (
    record.v !== 1 ||
    record.type !== "checkpoint" ||
    (typeof record.checkpointId !== "string" && record.checkpointId !== null) ||
    typeof record.hash !== "string" ||
    !state
  ) {
    return undefined;
  }
  return { v: 1, type: "checkpoint", checkpointId: record.checkpointId, state, hash: record.hash };
}

export function parseBootstrapAck(value: unknown): BootstrapAck | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "bootstrap-ack" ||
    typeof record.checkpointId !== "string"
  ) {
    return undefined;
  }
  return { v: 1, type: "bootstrap-ack", checkpointId: record.checkpointId };
}

function parseFrame(value: unknown): InputFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.tick)) return undefined;
  if (typeof record.moves !== "object" || record.moves === null || Array.isArray(record.moves)) {
    return undefined;
  }
  const moves: Record<string, Move> = {};
  for (const [userId, move] of Object.entries(record.moves)) {
    if (move !== -1 && move !== 0 && move !== 1) return undefined;
    moves[userId] = move;
  }
  return { tick: record.tick as number, moves };
}

function parseState(value: unknown): SimState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.tick) ||
    !Number.isSafeInteger(record.rngState) ||
    typeof record.positionsMm !== "object" ||
    record.positionsMm === null ||
    Array.isArray(record.positionsMm)
  ) {
    return undefined;
  }
  const positionsMm: Record<string, number> = {};
  for (const [userId, position] of Object.entries(record.positionsMm)) {
    if (!Number.isSafeInteger(position)) return undefined;
    positionsMm[userId] = position as number;
  }
  return {
    tick: record.tick as number,
    positionsMm,
    rngState: record.rngState as number,
  };
}
```

## Authoritative Server Frames

```ts
// src/server.ts
import { server, type Connection } from "snack:server";
import {
  parseBootstrapAck,
  parseInputBundle,
  type Checkpoint,
  type FrameBundle,
} from "./shared/messages.js";
import {
  cloneState,
  hashState,
  step,
  type InputFrame,
  type Move,
  type SimState,
} from "./shared/simulation.js";

const DATAGRAM_BUDGET_BYTES = 1000;
const pending = new Map<number, Map<string, Move>>();
const recentFrames: InputFrame[] = [];
type PendingCheckpoint = {
  message: Checkpoint;
  lastSentAtMs: number;
  attempts: number;
  acknowledged: boolean;
};
const pendingCheckpoints = new Map<string, PendingCheckpoint>();
const activeConnectionByUser = new Map<string, string>();
const retiredConnectionIds = new Set<string>();
const TICK_MS = 1000 / 60;
const MAX_CATCH_UP_STEPS = 4;
const MAX_INPUT_LEAD_TICKS = 50;
const BOOTSTRAP_RETRY_MS = 500;
const MAX_BOOTSTRAP_ATTEMPTS = 20;
let state: SimState = { tick: 0, positionsMm: {}, rngState: 0x12345678 };
let nextCheckpointId = 0;

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
        server.streams.broadcast(makeCheckpoint(null), { only: readyIds });
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
    const bundle = parseInputBundle(safeJson(event));
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

  const bundle = boundedFrameBundle(recentFrames);
  const readyIds = readyConnectionIds();
  if (bundle.frames.length > 0) {
    if (readyIds.length > 0) server.datagrams.broadcast(bundle, { only: readyIds });
  } else {
    // A single full-world frame no longer fits a path-MTU datagram. Preserve correctness reliably;
    // then redesign with fewer rollback peers, compact ids, or interest groups.
    if (readyIds.length > 0) {
      server.streams.broadcast({ v: 1, type: "frame-bundle", frames: [frame] }, { only: readyIds });
    }
  }

  if (state.tick % 120 === 0 && readyIds.length > 0) {
    server.streams.broadcast(makeCheckpoint(null), { only: readyIds });
  }
}

function boundedFrameBundle(frames: InputFrame[]): FrameBundle {
  let selected: InputFrame[] = [];
  for (const frame of [...frames].reverse()) {
    const candidate: FrameBundle = {
      v: 1,
      type: "frame-bundle",
      frames: [frame, ...selected],
    };
    if (encodedBytes(candidate) > DATAGRAM_BUDGET_BYTES) break;
    selected = candidate.frames;
  }
  return { v: 1, type: "frame-bundle", frames: selected };
}

function encodedBytes(message: FrameBundle): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

function makeCheckpoint(checkpointId: string | null): Checkpoint {
  return {
    v: 1,
    type: "checkpoint",
    checkpointId,
    state: cloneState(state),
    hash: hashState(state),
  };
}

function sendNewConnectionCheckpoints(): void {
  const nowMs = server.elapsedMs();
  const newestByUser = newestConnectionByUser();
  for (const connection of server.connections) {
    if (newestByUser.get(connection.userId)?.id !== connection.id) continue;
    let pending = pendingCheckpoints.get(connection.id);
    if (!pending) {
      pending = {
        message: makeCheckpoint(`${connection.id}:${nextCheckpointId++}`),
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
    connection.streams.send(pending.message);
    pending.lastSentAtMs = nowMs;
    pending.attempts += 1;
  }
}

function receiveBootstrapAcks(): boolean {
  let activated = false;
  for (const event of server.streams.drain()) {
    const ack = parseBootstrapAck(safeJson(event));
    const pending = pendingCheckpoints.get(event.connection.id);
    if (
      !ack ||
      pending?.message.checkpointId !== ack.checkpointId ||
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

function safeJson(event: { json(): unknown }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
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
  parseCheckpoint,
  parseFrameBundle,
  type BootstrapAck,
  type FrameBundle,
  type InputBundle,
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
import type { Move } from "./shared/simulation.js";

const STEP_MS = 1000 / 60;
const DATAGRAM_BUDGET_BYTES = 1000;
const MAX_INPUT_LEAD_TICKS = 50;
const MAX_SUPPORTED_RTT_MS = 500;
const unconfirmedInputs: LocalInput[] = [];
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
  const bundle = boundedInputBundle(unconfirmedInputs);
  if (bundle.inputs.length > 0) await client.datagrams.send(bundle);
}

function boundedInputBundle(inputs: LocalInput[]): InputBundle {
  let selected: LocalInput[] = [];
  for (const input of [...inputs].reverse()) {
    const candidate: InputBundle = {
      v: 1,
      type: "input-bundle",
      inputs: [input, ...selected],
    };
    if (encodedBytes(candidate) > DATAGRAM_BUDGET_BYTES) break;
    selected = candidate.inputs;
  }
  return { v: 1, type: "input-bundle", inputs: selected };
}

function encodedBytes(message: InputBundle | FrameBundle): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

function receiveAuthoritativeFrames(): void {
  for (const event of client.datagrams.drain()) {
    const bundle = parseFrameBundle(safeJson(event));
    if (bundle) applyFrames(bundle);
  }
}

function applyFrames(bundle: FrameBundle): void {
  for (const frame of bundle.frames) {
    acceptAuthoritativeFrame(frame);
    const localMove = frame.moves[localUserId];
    if (localMove !== undefined) {
      const index = unconfirmedInputs.findIndex((input) => input.tick === frame.tick);
      if (index >= 0) unconfirmedInputs.splice(0, index + 1);
    }
  }
}

async function receiveReliableMessages(): Promise<void> {
  for await (const event of client.streams) {
    const value = safeJson(event);
    const frameBundle = parseFrameBundle(value);
    if (frameBundle) {
      applyFrames(frameBundle);
      continue;
    }
    const checkpoint = parseCheckpoint(value);
    if (!checkpoint) continue;
    const result = applyCheckpoint(checkpoint.state, checkpoint.hash);
    if (result === "hash-mismatch") {
      console.error("ignored an invalid checkpoint; waiting for the next reliable checkpoint");
      continue;
    }
    if (checkpoint.checkpointId) {
      const ack: BootstrapAck = {
        v: 1,
        type: "bootstrap-ack",
        checkpointId: checkpoint.checkpointId,
      };
      await client.streams.send(ack);
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

function safeJson(event: { json(): unknown }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
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
shooter may also use `snack-multiplayer-lag-compensation` to retain a bounded hitbox history and
rewind hit validation by a clamped amount derived from RTT and jitter. Keep damage, ammo, cooldowns,
and the rewind limit authoritative on the server.

## Side Effects

Do not emit irreversible effects directly from `step()`:

- play confirmed audio or particles after the tick is authoritative, or deduplicate by event id
- keep analytics and persistence outside replay
- never double-apply score, inventory, or UI notifications during resimulation
