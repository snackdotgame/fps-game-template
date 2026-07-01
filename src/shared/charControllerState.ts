// Binary wire format for the jolt-ts character-controller's deterministic state
// (jolt-ts-character-controller `SyncState`). Fixed 65-byte little-endian
// layout so it drops straight into snapshots and reconciliation:
//
//   16 × float32  position(3) velocity(3) rotation(4) angularVelocity(3) gravityDir(3)
//    1 × uint8    flags: bit0 onGround, bit1 canJump
//
// Restoring a controller from these bytes (applySyncState) reproduces it
// exactly, which is what client prediction/rollback needs.

import type { SyncState } from "jolt-ts-character-controller";

export const CHAR_STATE_FLOATS = 17; // + jumpElapsed
export const CHAR_STATE_BYTES = CHAR_STATE_FLOATS * 4 + 1; // 69

const FLAG_ON_GROUND = 1 << 0;
const FLAG_CAN_JUMP = 1 << 1;
const FLAG_JUMP_ACTIVE = 1 << 2;

// Write one controller state at `offset`; returns the next free byte offset.
export function writeCharControllerState(state: SyncState, view: DataView, offset = 0): number {
  let o = offset;
  const f = (n: number): void => {
    view.setFloat32(o, n, true);
    o += 4;
  };
  f(state.position[0]);
  f(state.position[1]);
  f(state.position[2]);
  f(state.linearVelocity[0]);
  f(state.linearVelocity[1]);
  f(state.linearVelocity[2]);
  f(state.rotation[0]);
  f(state.rotation[1]);
  f(state.rotation[2]);
  f(state.rotation[3]);
  f(state.angularVelocity[0]);
  f(state.angularVelocity[1]);
  f(state.angularVelocity[2]);
  f(state.gravityDir[0]);
  f(state.gravityDir[1]);
  f(state.gravityDir[2]);
  f(state.jumpElapsed);
  let flags = 0;
  if (state.onGround) flags |= FLAG_ON_GROUND;
  if (state.canJump) flags |= FLAG_CAN_JUMP;
  if (state.jumpActive) flags |= FLAG_JUMP_ACTIVE;
  view.setUint8(o, flags);
  return o + 1;
}

// Read one controller state from `offset`.
export function readCharControllerState(view: DataView, offset = 0): SyncState {
  let o = offset;
  const f = (): number => {
    const n = view.getFloat32(o, true);
    o += 4;
    return n;
  };
  const position: [number, number, number] = [f(), f(), f()];
  const linearVelocity: [number, number, number] = [f(), f(), f()];
  const rotation: [number, number, number, number] = [f(), f(), f(), f()];
  const angularVelocity: [number, number, number] = [f(), f(), f()];
  const gravityDir: [number, number, number] = [f(), f(), f()];
  const jumpElapsed = f();
  const flags = view.getUint8(o);
  return {
    position,
    linearVelocity,
    rotation,
    angularVelocity,
    gravityDir,
    onGround: (flags & FLAG_ON_GROUND) !== 0,
    canJump: (flags & FLAG_CAN_JUMP) !== 0,
    jumpActive: (flags & FLAG_JUMP_ACTIVE) !== 0,
    jumpElapsed,
  };
}

export function encodeCharControllerState(state: SyncState): Uint8Array {
  const bytes = new Uint8Array(CHAR_STATE_BYTES);
  writeCharControllerState(state, new DataView(bytes.buffer));
  return bytes;
}

export function decodeCharControllerState(bytes: Uint8Array): SyncState {
  return readCharControllerState(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}
