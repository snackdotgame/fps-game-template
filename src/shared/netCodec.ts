// Binary wire formats. Inputs (client -> server) carry view angles for
// server-side hit detection; snapshots (server -> client) are idempotent full
// dynamic state plus a ring of recent transient events (tracers, impacts,
// explosions) — latest-wins, no retransmission. Reliable stream messages are
// JSON (messages.ts).

import type { CharState, InputCmd } from "./physics.js";

export const PKT_INPUT = 1;
export const PKT_SNAPSHOT = 2;

export function quantizeMove(v: number): number {
  const q = Math.round(Math.max(-1, Math.min(1, v)) * 127);
  return q / 127;
}

// Angles quantized to i16; the client simulates with the same quantized
// values it sends so prediction and authority aim identically.
const ANGLE_SCALE = 10000;

export function quantizeAngle(v: number): number {
  return Math.round(v * ANGLE_SCALE) / ANGLE_SCALE;
}

// --- Input packets -----------------------------------------------------------
// [u8 type][u8 count] then per input:
// [u32 seq][i8 mx][i8 mz][i16 yaw][i16 pitch][u8 buttons][u16 viewTick]
// (13 bytes). viewTick is the low 16 bits of the server tick of the world the
// client was RENDERING at sample time — the server rewinds hit tests to it.

const BTN_JUMP = 1;
const BTN_SPRINT = 2;
const BTN_FIRE = 4;
const BTN_RELOAD = 8;
const BTN_GRENADE = 16;
const BTN_MELEE = 32;
const BTN_BUILD = 64;
const BTN_SLOT2 = 128; // desired weapon slot: set = sidearm

export function encodeInputs(cmds: readonly InputCmd[]): Uint8Array {
  const buf = new ArrayBuffer(2 + cmds.length * 13);
  const dv = new DataView(buf);
  dv.setUint8(0, PKT_INPUT);
  dv.setUint8(1, cmds.length);
  let o = 2;
  for (const c of cmds) {
    dv.setUint32(o, c.seq >>> 0);
    dv.setInt8(o + 4, Math.round(c.moveX * 127));
    dv.setInt8(o + 5, Math.round(c.moveZ * 127));
    dv.setInt16(o + 6, Math.round(c.yaw * ANGLE_SCALE) | 0);
    dv.setInt16(o + 8, Math.round(c.pitch * ANGLE_SCALE) | 0);
    dv.setUint8(
      o + 10,
      (c.jump ? BTN_JUMP : 0) |
        (c.sprint ? BTN_SPRINT : 0) |
        (c.fire ? BTN_FIRE : 0) |
        (c.reload ? BTN_RELOAD : 0) |
        (c.grenade ? BTN_GRENADE : 0) |
        (c.melee ? BTN_MELEE : 0) |
        (c.build ? BTN_BUILD : 0) |
        (c.slot2 ? BTN_SLOT2 : 0),
    );
    dv.setUint16(o + 11, c.viewTick & 0xffff);
    o += 13;
  }
  return new Uint8Array(buf);
}

export function decodeInputs(bytes: Uint8Array): InputCmd[] | null {
  if (bytes.length < 2 || bytes[0] !== PKT_INPUT) return null;
  const count = bytes[1];
  if (bytes.length < 2 + count * 13) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: InputCmd[] = [];
  let o = 2;
  for (let i = 0; i < count; i++) {
    const b = dv.getUint8(o + 10);
    out.push({
      seq: dv.getUint32(o),
      moveX: dv.getInt8(o + 4) / 127,
      moveZ: dv.getInt8(o + 5) / 127,
      yaw: dv.getInt16(o + 6) / ANGLE_SCALE,
      pitch: dv.getInt16(o + 8) / ANGLE_SCALE,
      jump: (b & BTN_JUMP) !== 0,
      sprint: (b & BTN_SPRINT) !== 0,
      fire: (b & BTN_FIRE) !== 0,
      reload: (b & BTN_RELOAD) !== 0,
      grenade: (b & BTN_GRENADE) !== 0,
      melee: (b & BTN_MELEE) !== 0,
      build: (b & BTN_BUILD) !== 0,
      slot2: (b & BTN_SLOT2) !== 0,
      viewTick: dv.getUint16(o + 11),
    });
    o += 13;
  }
  return out;
}

// Reconstruct a wrapped u16 viewTick to the full tick nearest (and not
// after) `currentTick`.
export function unwrapViewTick(raw: number, currentTick: number): number {
  let v = (currentTick & ~0xffff) | (raw & 0xffff);
  if (v > currentTick) v -= 0x10000;
  if (currentTick - v > 0x8000) v += 0x10000;
  return Math.min(v, currentTick);
}

// --- Snapshot packets --------------------------------------------------------

// Remote pose flag bits.
export const RF_TEAM = 1; // team 1 if set
export const RF_GROUND = 2;
export const RF_DEAD = 4;
export const RF_SPRINT = 8;
export const RF_RELOADING = 16;
export const RF_PROTECTED = 32;

// Self status bits.
export const SS_DEAD = 1;
export const SS_PROTECTED = 2;

// Transient event kinds (ring-buffered in snapshots; fire-and-forget).
export const EV_TRACER = 1; // a: shooter idx; point: tracer end
export const EV_HIT_PLAYER = 2; // a: victim idx; point: impact
export const EV_EXPLOSION = 3; // a: 0; point: center
export const EV_PANEL_HIT = 4; // a: 0; point: impact (chip spark)
export const EV_MELEE = 5; // a: attacker idx; point: swing impact

export interface GameEvent {
  seq: number; // u16, wraps; client dedupes
  kind: number;
  a: number;
  x: number;
  y: number;
  z: number;
}

export interface SelfSnap {
  ackSeq: number;
  ackTick: number;
  status: number; // SS_* bits
  bufferDepth: number; // input-rate servo feedback
  hp: number;
  respawnTicks: number;
  state: CharState;
}

export interface RemoteSnap {
  idx: number;
  flags: number; // RF_* bits
  // Weapon byte: active weapon index (low nibble, drives the held model) and
  // class primary index (high nibble, drives the character model).
  weapon: number;
  x: number; // feet
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export function packWeaponByte(active: number, primary: number): number {
  return (active & 0xf) | ((primary & 0xf) << 4);
}

export function weaponByteActive(w: number): number {
  return w & 0xf;
}

export function weaponBytePrimary(w: number): number {
  return (w >> 4) & 0xf;
}

export interface EntitySnap {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  fuseTicks: number;
}

// A falling compound chunk's live pose — the server streams these every
// snapshot while the chunk tumbles, so clients render the authoritative
// motion instead of guessing.
export interface ChunkSnap {
  id: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

// Conquest zone state: owner (-1 neutral / 0 / 1) and the capture meter
// (-100 fully team0 ... +100 fully team1).
export interface ZoneSnap {
  owner: number;
  v: number;
}

export interface Snapshot {
  serverTick: number;
  phase: number; // 0 playing, 1 results
  phaseEndTick: number;
  tickets: [number, number];
  zones: ZoneSnap[];
  self: SelfSnap;
  remotes: RemoteSnap[];
  entities: EntitySnap[];
  chunks: ChunkSnap[];
  events: GameEvent[];
}

const SELF_FIXED = 4 + 4 + 1 + 1 + 1 + 2; // ack, tick, status, depth, hp, respawn
// pos/vel f64, flags, counters (coyote/cooldown/reload/ammo/ammo2/slotPrimary/
// recoil/grenades/supply), jumpElapsed f32
const SELF_STATE = 6 * 8 + 1 + 9 + 4;
const REMOTE_BYTES = 1 + 1 + 1 + 3 * 4 + 4 + 2;
const ENTITY_BYTES = 1 + 6 * 4 + 1;
const CHUNK_BYTES = 4 + 7 * 4;
const ZONE_BYTES = 2;
const EVENT_BYTES = 2 + 1 + 1 + 3 * 4;

export function encodeSnapshot(snap: Snapshot): Uint8Array {
  const size =
    1 +
    4 +
    1 +
    4 +
    SELF_FIXED +
    SELF_STATE +
    1 +
    snap.remotes.length * REMOTE_BYTES +
    1 +
    snap.entities.length * ENTITY_BYTES +
    1 +
    snap.chunks.length * CHUNK_BYTES +
    4 +
    1 +
    snap.zones.length * ZONE_BYTES +
    1 +
    snap.events.length * EVENT_BYTES;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o, PKT_SNAPSHOT);
  dv.setUint32(o + 1, snap.serverTick >>> 0);
  dv.setUint8(o + 5, snap.phase);
  dv.setUint32(o + 6, snap.phaseEndTick >>> 0);
  o = 10;

  const s = snap.self;
  dv.setUint32(o, s.ackSeq >>> 0);
  dv.setUint32(o + 4, s.ackTick >>> 0);
  dv.setUint8(o + 8, s.status);
  dv.setUint8(o + 9, Math.min(255, s.bufferDepth));
  dv.setUint8(o + 10, Math.max(0, Math.round(s.hp)));
  dv.setUint16(o + 11, s.respawnTicks);
  o += 13;
  const st = s.state;
  for (const v of [st.x, st.y, st.z, st.vx, st.vy, st.vz]) {
    dv.setFloat64(o, v);
    o += 8;
  }
  dv.setUint8(
    o,
    (st.onGround ? 1 : 0) |
      (st.jumpHeld ? 2 : 0) |
      (st.fireHeld ? 4 : 0) |
      (st.grenadeHeld ? 8 : 0) |
      (st.meleeHeld ? 16 : 0) |
      (st.buildHeld ? 32 : 0) |
      (st.canJump ? 64 : 0) |
      (st.jumpActive ? 128 : 0),
  );
  dv.setUint8(o + 1, st.coyoteTicks);
  dv.setUint8(o + 2, st.cooldownTicks);
  dv.setUint8(o + 3, st.reloadTicks);
  dv.setUint8(o + 4, st.ammo);
  dv.setUint8(o + 5, st.ammo2);
  dv.setUint8(o + 6, packWeaponByte(st.slot, st.primary));
  dv.setUint8(o + 7, st.recoilTicks);
  dv.setUint8(o + 8, st.grenades);
  dv.setUint8(o + 9, st.supply);
  o += 10;
  dv.setFloat32(o, st.jumpElapsed, true);
  o += 4;

  dv.setUint8(o++, snap.remotes.length);
  for (const r of snap.remotes) {
    dv.setUint8(o, r.idx);
    dv.setUint8(o + 1, r.flags);
    dv.setUint8(o + 2, r.weapon);
    dv.setFloat32(o + 3, r.x);
    dv.setFloat32(o + 7, r.y);
    dv.setFloat32(o + 11, r.z);
    dv.setFloat32(o + 15, r.yaw);
    dv.setInt16(o + 19, Math.round(r.pitch * ANGLE_SCALE) | 0);
    o += REMOTE_BYTES;
  }

  dv.setUint8(o++, snap.entities.length);
  for (const e of snap.entities) {
    dv.setUint8(o, e.id);
    dv.setFloat32(o + 1, e.x);
    dv.setFloat32(o + 5, e.y);
    dv.setFloat32(o + 9, e.z);
    dv.setFloat32(o + 13, e.vx);
    dv.setFloat32(o + 17, e.vy);
    dv.setFloat32(o + 21, e.vz);
    dv.setUint8(o + 25, Math.min(255, e.fuseTicks));
    o += ENTITY_BYTES;
  }

  dv.setUint8(o++, snap.chunks.length);
  for (const c of snap.chunks) {
    dv.setUint32(o, c.id >>> 0);
    dv.setFloat32(o + 4, c.x);
    dv.setFloat32(o + 8, c.y);
    dv.setFloat32(o + 12, c.z);
    dv.setFloat32(o + 16, c.qx);
    dv.setFloat32(o + 20, c.qy);
    dv.setFloat32(o + 24, c.qz);
    dv.setFloat32(o + 28, c.qw);
    o += CHUNK_BYTES;
  }

  dv.setUint16(o, Math.max(0, snap.tickets[0]));
  dv.setUint16(o + 2, Math.max(0, snap.tickets[1]));
  o += 4;
  dv.setUint8(o++, snap.zones.length);
  for (const zn of snap.zones) {
    dv.setUint8(o, zn.owner + 1);
    dv.setInt8(o + 1, Math.round(zn.v / 1));
    o += ZONE_BYTES;
  }

  dv.setUint8(o++, snap.events.length);
  for (const e of snap.events) {
    dv.setUint16(o, e.seq & 0xffff);
    dv.setUint8(o + 2, e.kind);
    dv.setUint8(o + 3, e.a);
    dv.setFloat32(o + 4, e.x);
    dv.setFloat32(o + 8, e.y);
    dv.setFloat32(o + 12, e.z);
    o += EVENT_BYTES;
  }
  return new Uint8Array(buf);
}

export function decodeSnapshot(bytes: Uint8Array): Snapshot | null {
  if (bytes.length < 10 + SELF_FIXED + SELF_STATE + 3 || bytes[0] !== PKT_SNAPSHOT) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const serverTick = dv.getUint32(1);
  const phase = dv.getUint8(5);
  const phaseEndTick = dv.getUint32(6);
  let o = 10;

  const ackSeq = dv.getUint32(o);
  const ackTick = dv.getUint32(o + 4);
  const status = dv.getUint8(o + 8);
  const bufferDepth = dv.getUint8(o + 9);
  const hp = dv.getUint8(o + 10);
  const respawnTicks = dv.getUint16(o + 11);
  o += 13;
  const nums: number[] = [];
  for (let i = 0; i < 6; i++) {
    nums.push(dv.getFloat64(o));
    o += 8;
  }
  const flags = dv.getUint8(o);
  const state: CharState = {
    x: nums[0],
    y: nums[1],
    z: nums[2],
    vx: nums[3],
    vy: nums[4],
    vz: nums[5],
    onGround: (flags & 1) !== 0,
    jumpHeld: (flags & 2) !== 0,
    fireHeld: (flags & 4) !== 0,
    grenadeHeld: (flags & 8) !== 0,
    meleeHeld: (flags & 16) !== 0,
    buildHeld: (flags & 32) !== 0,
    canJump: (flags & 64) !== 0,
    jumpActive: (flags & 128) !== 0,
    coyoteTicks: dv.getUint8(o + 1),
    cooldownTicks: dv.getUint8(o + 2),
    reloadTicks: dv.getUint8(o + 3),
    ammo: dv.getUint8(o + 4),
    ammo2: dv.getUint8(o + 5),
    slot: weaponByteActive(dv.getUint8(o + 6)),
    primary: weaponBytePrimary(dv.getUint8(o + 6)),
    recoilTicks: dv.getUint8(o + 7),
    grenades: dv.getUint8(o + 8),
    supply: dv.getUint8(o + 9),
    jumpElapsed: dv.getFloat32(o + 10, true),
  };
  o += 14;

  const remotes: RemoteSnap[] = [];
  const remoteCount = dv.getUint8(o++);
  if (bytes.length < o + remoteCount * REMOTE_BYTES + 2) return null;
  for (let i = 0; i < remoteCount; i++) {
    remotes.push({
      idx: dv.getUint8(o),
      flags: dv.getUint8(o + 1),
      weapon: dv.getUint8(o + 2),
      x: dv.getFloat32(o + 3),
      y: dv.getFloat32(o + 7),
      z: dv.getFloat32(o + 11),
      yaw: dv.getFloat32(o + 15),
      pitch: dv.getInt16(o + 19) / ANGLE_SCALE,
    });
    o += REMOTE_BYTES;
  }

  const entities: EntitySnap[] = [];
  const entityCount = dv.getUint8(o++);
  if (bytes.length < o + entityCount * ENTITY_BYTES + 1) return null;
  for (let i = 0; i < entityCount; i++) {
    entities.push({
      id: dv.getUint8(o),
      x: dv.getFloat32(o + 1),
      y: dv.getFloat32(o + 5),
      z: dv.getFloat32(o + 9),
      vx: dv.getFloat32(o + 13),
      vy: dv.getFloat32(o + 17),
      vz: dv.getFloat32(o + 21),
      fuseTicks: dv.getUint8(o + 25),
    });
    o += ENTITY_BYTES;
  }

  const chunks: ChunkSnap[] = [];
  const chunkCount = dv.getUint8(o++);
  if (bytes.length < o + chunkCount * CHUNK_BYTES + 1) return null;
  for (let i = 0; i < chunkCount; i++) {
    chunks.push({
      id: dv.getUint32(o),
      x: dv.getFloat32(o + 4),
      y: dv.getFloat32(o + 8),
      z: dv.getFloat32(o + 12),
      qx: dv.getFloat32(o + 16),
      qy: dv.getFloat32(o + 20),
      qz: dv.getFloat32(o + 24),
      qw: dv.getFloat32(o + 28),
    });
    o += CHUNK_BYTES;
  }

  if (bytes.length < o + 5) return null;
  const tickets: [number, number] = [dv.getUint16(o), dv.getUint16(o + 2)];
  o += 4;
  const zones: ZoneSnap[] = [];
  const zoneCount = dv.getUint8(o++);
  if (bytes.length < o + zoneCount * ZONE_BYTES + 1) return null;
  for (let i = 0; i < zoneCount; i++) {
    zones.push({ owner: dv.getUint8(o) - 1, v: dv.getInt8(o + 1) });
    o += ZONE_BYTES;
  }

  const events: GameEvent[] = [];
  const eventCount = dv.getUint8(o++);
  if (bytes.length < o + eventCount * EVENT_BYTES) return null;
  for (let i = 0; i < eventCount; i++) {
    events.push({
      seq: dv.getUint16(o),
      kind: dv.getUint8(o + 2),
      a: dv.getUint8(o + 3),
      x: dv.getFloat32(o + 4),
      y: dv.getFloat32(o + 8),
      z: dv.getFloat32(o + 12),
    });
    o += EVENT_BYTES;
  }

  return {
    serverTick,
    phase,
    phaseEndTick,
    tickets,
    zones,
    self: { ackSeq, ackTick, status, bufferDepth, hp, respawnTicks, state },
    remotes,
    entities,
    chunks,
    events,
  };
}
