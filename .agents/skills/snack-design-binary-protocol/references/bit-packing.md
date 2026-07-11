# Bitpacking And Quantization

## Contents

- When to bitpack
- Bit writer and reader
- Ranged integers
- Float quantization
- Smallest-three quaternions
- Padding, sentinels, and codec discipline

## When To Bitpack

Bitpack only after byte-aligned `DataView` layouts (protocol rung 2) exceed the datagram budget.
The win is real — a 29-bit orientation instead of 4 bytes, 1-bit flags instead of 1-byte booleans,
a 9-bit entity id instead of 2 bytes — but the encoded stream is no longer inspectable byte by
byte, so codec tests and debug formatters carry more weight.

JavaScript bitwise operators truncate to 32 bits, so the implementations below use exact
multiply/divide arithmetic instead of shifts. Each ranged field may span at most 2^32 distinct
offsets (`max - min < 2^32`); split larger values into multiple fields. Within that limit all
intermediate values stay under 2^53, so every operation is exact. Bits are packed
least-significant-first into little-endian bytes.

## Bit Writer And Reader

```ts
// src/shared/bit-packing.ts
export function bitsRequired(min: number, max: number): number {
  const range = max - min;
  if (!Number.isSafeInteger(range)) throw new Error("bitsRequired: range must be a safe integer");
  if (range <= 0) return 0;
  if (range >= 2 ** 32) throw new Error("bitsRequired: range must be less than 2^32");
  return Math.ceil(Math.log2(range + 1));
}

export class BitWriter {
  private bytes: Uint8Array;
  private byteIndex = 0;
  private scratch = 0;
  private scratchBits = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  get bitsWritten(): number {
    return this.byteIndex * 8 + this.scratchBits;
  }

  writeBits(value: number, bits: number): void {
    if (!Number.isInteger(value) || value < 0 || bits < 1 || bits > 32 || value >= 2 ** bits) {
      throw new Error(`writeBits: ${value} does not fit in ${bits} bits`);
    }
    this.scratch += value * 2 ** this.scratchBits;
    this.scratchBits += bits;
    while (this.scratchBits >= 8) {
      if (this.byteIndex >= this.bytes.length) throw new Error("BitWriter capacity exceeded");
      this.bytes[this.byteIndex] = this.scratch % 256;
      this.byteIndex += 1;
      this.scratch = Math.floor(this.scratch / 256);
      this.scratchBits -= 8;
    }
  }

  writeRangedInt(value: number, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`writeRangedInt: ${value} outside [${min}, ${max}]`);
    }
    const bits = bitsRequired(min, max);
    if (bits > 0) this.writeBits(value - min, bits);
  }

  finish(): Uint8Array {
    if (this.scratchBits > 0) {
      if (this.byteIndex >= this.bytes.length) throw new Error("BitWriter capacity exceeded");
      this.bytes[this.byteIndex] = this.scratch % 256;
      this.byteIndex += 1;
      this.scratch = 0;
      this.scratchBits = 0;
    }
    return this.bytes.subarray(0, this.byteIndex);
  }
}

export class BitReader {
  private byteIndex = 0;
  private scratch = 0;
  private scratchBits = 0;

  constructor(private bytes: Uint8Array) {}

  readBits(bits: number): number | undefined {
    if (bits < 1 || bits > 32) return undefined;
    while (this.scratchBits < bits) {
      if (this.byteIndex >= this.bytes.length) return undefined;
      this.scratch += this.bytes[this.byteIndex] * 2 ** this.scratchBits;
      this.byteIndex += 1;
      this.scratchBits += 8;
    }
    const value = this.scratch % 2 ** bits;
    this.scratch = Math.floor(this.scratch / 2 ** bits);
    this.scratchBits -= bits;
    return value;
  }

  readRangedInt(min: number, max: number): number | undefined {
    const bits = bitsRequired(min, max);
    if (bits === 0) return min;
    const raw = this.readBits(bits);
    if (raw === undefined) return undefined;
    const value = min + raw;
    return value > max ? undefined : value;
  }

  /** True when every byte is consumed and remaining final-byte padding bits are zero. */
  paddingValid(): boolean {
    return this.byteIndex === this.bytes.length && this.scratch === 0;
  }
}
```

Local encoders throw on programmer error before a packet is sent; remote decoders return
`undefined` and never throw into the authoritative loop, matching the shared protocol rules.

`readRangedInt` shows the non-negotiable rule: reading the right number of bits is not enough. A
field with range `[0, 900]` occupies 10 bits, so raw values 901–1023 decode without any bit-level
error and must be rejected by the range check. Skipping this check is how malicious packets turn
into out-of-bounds indices and unbounded loops.

## Float Quantization

Bound the value, pick a resolution, and ship an integer:

```ts
export function quantizeFloat(value: number, min: number, max: number, bits: number): number {
  const steps = 2 ** bits - 1;
  const t = (Math.min(max, Math.max(min, value)) - min) / (max - min);
  return Math.round(t * steps);
}

export function dequantizeFloat(quantized: number, min: number, max: number, bits: number): number {
  return min + (quantized / (2 ** bits - 1)) * (max - min);
}
```

Guidance:

- Derive bit width from gameplay requirements: bound the world (positions), bound the physics
  (velocities), then choose the coarsest resolution nobody notices. A 512 m world at 512 steps/m
  (~2 mm) costs 18 bits per axis; presentation-only state rarely needs more.
- State that feeds back into simulation — prediction baselines, state sync — needs finer grids
  (e.g. 4,096 steps/m) or corrections visibly fight the local simulation.
- When the server compares values for delta encoding or at-rest detection, compare in quantized
  integer space. Quantize once, then treat the integers as the authoritative wire values;
  re-quantizing floats on each comparison creates flicker where values straddle a grid line.
- Add an at-rest flag where it pays: one bit that says "no velocity follows" makes idle entities
  dramatically cheaper in worlds where most things hold still.

## Smallest-Three Quaternions

A unit quaternion satisfies x² + y² + z² + w² = 1, so the largest-magnitude component is
recoverable from the other three, and those three are each bounded by ±1/√2. Send a 2-bit index of
the dropped component plus three quantized components: 29 bits at 9-bit precision instead of 128
bits of floats. The encoder requires finite, normalized input and throws on programmer error.

```ts
const QUAT_COMPONENT_MAX = 1 / Math.SQRT2;

export type Quat = readonly [number, number, number, number];

export function writeQuaternion(w: BitWriter, q: Quat, componentBits: number): void {
  const squaredLength = q.reduce((sum, component) => sum + component * component, 0);
  if (q.some((component) => !Number.isFinite(component)) || Math.abs(squaredLength - 1) > 1e-4) {
    throw new Error("writeQuaternion: expected a finite unit quaternion");
  }
  let largest = 0;
  for (let i = 1; i < 4; i += 1) {
    if (Math.abs(q[i]) > Math.abs(q[largest])) largest = i;
  }
  const sign = q[largest] < 0 ? -1 : 1; // q and -q are the same rotation
  w.writeBits(largest, 2);
  for (let i = 0; i < 4; i += 1) {
    if (i === largest) continue;
    w.writeBits(
      quantizeFloat(sign * q[i], -QUAT_COMPONENT_MAX, QUAT_COMPONENT_MAX, componentBits),
      componentBits,
    );
  }
}

export function readQuaternion(r: BitReader, componentBits: number): Quat | undefined {
  const largest = r.readBits(2);
  if (largest === undefined) return undefined;
  const rest: number[] = [];
  let sumSquares = 0;
  for (let i = 0; i < 3; i += 1) {
    const raw = r.readBits(componentBits);
    if (raw === undefined) return undefined;
    const c = dequantizeFloat(raw, -QUAT_COMPONENT_MAX, QUAT_COMPONENT_MAX, componentBits);
    rest.push(c);
    sumSquares += c * c;
  }
  if (sumSquares > 1.0001) return undefined; // impossible for honestly encoded rotations
  const recovered = Math.sqrt(Math.max(0, 1 - sumSquares));
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < 4; i += 1) out.push(i === largest ? recovered : rest[next++]);
  return out as unknown as Quat;
}
```

Use 9-bit components (29 bits total) for presentation, 15-bit components (47 bits) when the
orientation feeds a simulation. Normalize after decode if downstream math is sensitive to unit
length.

## Padding, Sentinels, And Codec Discipline

- After the last field, decoders must call `paddingValid()` and reject packets with unconsumed
  bytes or nonzero padding bits. Anything else is a covert channel and a drift risk.
- During development, interleave sentinel bytes between packet sections
  (`w.writeBits(0xa7, 8)` / check on read) so an encoder/decoder desync fails loudly at the
  section boundary instead of producing garbage fields downstream. Gate sentinels on one shared
  constant compiled into both client and server; the two sides must always agree.
- Keep writer and reader for each message adjacent in one `src/shared/` module. In C++ this is
  done with a single templated serialize function; in TypeScript, adjacency plus golden byte
  vectors and round-trip tests provide the same protection against the read and write paths
  drifting apart.
- Provide a `formatXForLog(bytes)` debug formatter per family that runs the real decoder.
  Bitpacked packets are unreadable in hex dumps, so the formatter is the only practical window
  into live traffic.
- Bitpacked layouts have zero slack: any field width, order, or range change is a new protocol
  version. Bump the leading version byte and reject mismatches.
