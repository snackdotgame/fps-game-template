# Input-sync netcode (deterministic lockstep + rollback)

Target architecture, replacing the snapshot system. The simulation is fully
deterministic (cross-platform deterministic Jolt build), so the only thing
that needs to cross the wire is **inputs**.

## Roles

- **Server = input sequencer + referee.** It assigns every player's input to
  a tick (the existing per-player buffer/servo keeps doing this), runs the
  sim itself (bots, late-join checkpoints, divergence beacon), and broadcasts
  **input frames**: `[tick, every active slot's 13-byte input]`. Bots are
  just slots whose inputs the server authors.
- **Clients run the full sim.** Same inputs, same order, same code ⇒ same
  state. No state on the wire in steady state.

## The shared sim (`src/shared/sim.ts`)

Everything that today lives in server.ts game logic moves into a
deterministic `GameSim`: players (fixed slots 0–15), shots + lag-comp rewind
(viewTick rides each input; history rings are sim state), damage/respawn,
destruction (slab damage sets + rebuild queues), support-island releases,
falling chunks, settles, fragments, craters + terrain rebuilds, grenades,
zones/tickets/phase. All randomness through one seeded rng inside the sim,
consumed in deterministic order. Roster changes (join/leave/team) enter the
sim as **control ops inside input frames**, so every sim applies them at the
same tick.

The sim emits a per-tick **event list** (tracer, hit, explosion, destroy,
settle, …) as pure data: clients drive presentation from events of ticks as
they're simulated; fx fire once per tick number (replays don't re-fire).

## Reliability: acks + in-order application

- Client → server: unchanged (redundant 8-input tail + server buffer).
- Server → client: every datagram carries **all frames the client hasn't
  acked** (client acks the latest contiguous frame tick inside its input
  packets). At 30Hz and sane RTTs that's a 3–6 frame tail (~1.5KB). A client
  more than ~20 frames behind is marked for **checkpoint resync** instead.
- Frames are applied strictly in tick order; gaps wait for the redundant
  tail to fill them (they always do, or resync kicks in).

## Rollback (client)

- Keep a **checkpoint at the last fully-confirmed tick**: Jolt
  `world.saveState` (in-place binary restore) + a clone of the JS sim state,
  plus a **body-op journal** (bodies created/removed since the checkpoint)
  so restore can undo set changes before the binary restore.
- Predicted head = confirmed + local inputs applied immediately + remote
  inputs predicted as repeat-last.
- On confirmed frames: restore checkpoint → apply confirmed frames in order
  → save new checkpoint → re-apply prediction to head.
- Rendering: local player from the predicted sim; remotes from the confirmed
  sim with short interpolation (no rollback pops on remotes); lag comp
  unchanged (it's sim logic).

## Late join / divergence safety

- Join: server sends a **checkpoint** on the reliable stream: sim data
  (destroyed set, built defs, craters, zones, tickets, player states, rng
  state, tick) + Jolt dynamic-body state, then frames from that tick.
- Every 60 ticks the server broadcasts a cheap **state hash** (FNV over key
  state). A client whose hash mismatches requests a fresh checkpoint and
  resyncs silently (visually identical to a rollback correction).

## Staging (each stage gated by the full playtest)

1. **Extract `GameSim`** — server-only refactor, zero behavior change;
   snapshots still flow. Proves the sim boundary.
2. **Shadow mode** — broadcast input frames + acks alongside snapshots;
   clients run a local sim from frames and compare the hash beacon; log
   divergence in the wild before trusting it.
3. **Cutover** — render from the local sims, remove snapshots, enable
   checkpoint join/resync. Bandwidth drops to ~7KB/s per client regardless
   of how much is collapsing.

Status: stage 1 done (sim extracted, playtest green); stage 2 in progress.

## Stage 2 design decisions

Determinism fixes the stage-1 sim still needs:

- **Bot rng split.** `botThink` consumed `sim.rng`, interleaving AI rolls
  with sim randomness (spread, rubble, spawns) that clients must replay.
  Bots get a server-private rng; `GameSim.rand` is only consumed inside the
  sim, in input/step order.
- **Slot-order apply.** Inputs were applied in connection-Map order, which
  clients can't reproduce. The server assembles each tick's frame and
  applies it in ascending slot order; clients do the same from the frame.
- **Quantized bot commands.** Bot cmds were raw floats (yaw beyond the i16
  angle range, |move| up to ~1.8); the server now applies the same
  wire-quantized cmd the frame carries, so replay sees identical bits.
- **Per-input apply context in the frame.** `locked` (dead/results/no-input)
  and `bufferWait` (server queue delay, feeds lag-comp rewind) are
  server-side bookkeeping; both ride the frame per input (1 flag byte +
  1 u8), so clients call `applyInput` with identical options. Bot inputs set
  an `isBot` flag (rewind 1).
- **Phase logic into the sim.** Round-end/idle-clock/sandbox-clock
  transitions move into `GameSim.stepWorld` (deterministic: roster + tick +
  scores); the server just broadcasts the JSON phase msg when the sim flips.
  Round reset stays server-orchestrated but lands at a deterministic tick
  (results `phaseEndTick`), which shadow sims replicate locally.
- **Roster ops in frames.** join(slot, team, kills, deaths) / leave(slot)
  apply at the top of their tick, before inputs, in recorded order — body
  creation order affects Jolt internals, so both sides must match.

Wire format:

- `PKT_FRAMES = 3` datagram: a tail of frames from `ackTick+1` (capped ~20,
  chunked into ≤ ~1100B datagrams, ≤4 per tick). Frame = tick u32, flags u8,
  optional state hash u32, ctl ops, inputs (slot u8 + flags u8 +
  bufferWait u8 + the 13B input record).
- Client acks ride the input packet header (u32 latest contiguous frame
  tick). Falling >20 frames behind = shadow broken for the round (stage 3:
  checkpoint resync).
- **Hash beacon**: every 60 ticks, FNV-1a over the full sim state (tick,
  phase, scores, rng cursor, zones, per-slot player state incl. f64 position
  bits, destruction sets in iteration order, built defs, falling chunk and
  grenade body poses, craters, id allocators). Computed at the end of
  `stepWorld` on both sides; mismatch = divergence, logged + shadow disabled
  until the next round (stage 2 measures, it doesn't correct).
- **Shadow start (stage 2 only)**: from a fresh round boundary or a young
  server — the server keeps a frame ring (~4096); a client that joins while
  the ring still reaches tick 1 gets the backlog on the reliable stream
  (`framelog` msg) and replays from `new GameSim(SIM_SEED)`. Clients that
  join later just ack frames and wait for the next round boundary. Stage 3
  replaces this with real checkpoints (`world.saveState` is exposed by
  jolt-ts and verified present).

Client memory budget (measured): the fixed Jolt heap is 128MB; one full
game world costs ~21MB and the gauge (`joltFreeMemory()`, `__fps.joltFree()`)
reads ~105MB free in steady combat — no leaks across world rebuilds, slab
rebuilds, craters, or body churn. A second shadow world fits comfortably.
