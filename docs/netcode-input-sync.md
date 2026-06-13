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

Status: stage 1 in progress.
