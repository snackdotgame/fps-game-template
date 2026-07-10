# Multiplayer-Safe Game Feel

## Contents

- Response hierarchy
- Simulation and presentation boundary
- Feedback events
- Movement and camera
- Impact and audio
- Comfort and accessibility
- Tuning and verification

## Response Hierarchy

Improve feel in this order:

1. reduce delay between input and visible local response
2. tune acceleration, deceleration, easing, anticipation, and recovery
3. clarify contact, damage, pickup, score, and objective events
4. reinforce important events with camera and animation
5. align audio with the visible event

Do not use effects to conceal delayed controls or unclear mechanics. Strong feedback should make
state easier to read, not hide the player's next decision.

## Simulation And Presentation Boundary

Keep these authoritative or deterministic as required by the selected multiplayer approach:

- positions and velocities used for collision
- health, damage, hits, score, inventory, cooldowns, and timers
- random outcomes and spawn decisions
- match, round, win, loss, and progression state

Keep these in client presentation unless gameplay explicitly depends on them:

- camera shake and FOV response
- screen flash, particles, trails, decals, and cosmetic animation
- controller vibration
- pitch/volume variation
- smoothing transforms and correction offsets

Never pause the authoritative server loop for local hitstop. Create the impression of impact by
holding or slowing selected client animation layers while server time continues. Never feed camera,
shake, squash, or smoothing offsets back into transmitted state.

For rollback, exclude non-deterministic presentation from saved simulation state. For snapshot
games, create effects from authoritative events or carefully tracked local predictions.

## Feedback Events

Give important effects a stable event id so a predicted event and its later confirmation do not
play twice:

```ts
export type FeedbackKind = "attack" | "hit" | "damage" | "pickup" | "score" | "round-end";

export interface FeedbackEvent {
  id: string;
  tick: number;
  kind: FeedbackKind;
  magnitude: number;
  sourceId?: string;
  targetId?: string;
}

export class FeedbackDeduplicator {
  private readonly seen = new Map<string, number>();

  accept(event: FeedbackEvent): boolean {
    if (this.seen.has(event.id)) return false;
    this.seen.set(event.id, event.tick);
    return true;
  }

  pruneBefore(oldestTick: number): void {
    for (const [id, tick] of this.seen) {
      if (tick < oldestTick) this.seen.delete(id);
    }
  }

  clear(): void {
    this.seen.clear();
  }
}
```

Use server-issued ids for authoritative effects. A locally predicted effect may use an input
sequence-derived id that the server repeats on confirmation. If the prediction is rejected, fade or
cancel its presentation without inventing an authoritative outcome.

Do not transmit purely cosmetic effects as game state when every client can derive them from a
compact confirmed event.

## Movement And Camera

Tune the player's primary motion before adding secondary effects:

- acceleration and deceleration
- turn rate and reversal behavior
- jump, dash, brake, or drift anticipation
- input buffering and coyote/grace windows when the genre warrants them
- camera follow lag, look-ahead, framing, and occlusion recovery
- correction thresholds for predicted or interpolated presentation

Keep remote interpolation and local correction separate from intentional camera easing. Otherwise a
camera may amplify small network corrections or hide large ones.

Use bounded, decaying camera response. Scale shake by event importance and cap stacked events. Keep
aim, hazards, opponents, and objective markers readable throughout the effect.

## Impact And Audio

Map event importance to a consistent feedback stack:

| Event class        | Possible presentation                                                 |
| ------------------ | --------------------------------------------------------------------- |
| minor pickup       | brief scale/pulse, small sound, HUD count response                    |
| movement ability   | trail or stretch, camera/FOV response, short sound                    |
| confirmed hit      | target flash, animation hold, bounded shake, impact sound             |
| player damage      | readable directional cue, HUD response, vibration, recovery tell      |
| score or objective | world and HUD confirmation, distinct audio, team visibility           |
| round end          | clear transition that does not obscure the final authoritative result |

Emit audio from discrete events, not every render frame. Resume Web Audio from a user gesture, stop
loops on teardown/restart, and keep mute and volume state consistent across fresh-launch rejoins.
Vary repeated
sounds only within a bounded range and use seeded variation when visual or replay tests require it.

## Comfort And Accessibility

- honor `prefers-reduced-motion` and expose a game setting when motion is substantial
- reduce or disable shake, FOV changes, flashes, and large parallax without removing rule feedback
- avoid rapid flashing and extreme full-screen contrast changes
- provide non-audio confirmation for critical information
- use directional, shape, timing, or text cues in addition to color
- do not make controller vibration the only damage or objective cue

## Tuning And Verification

Create named tuning constants per feedback family. Change one family, capture active play, and test
with feedback enabled and reduced.

Verify:

- the primary verb creates immediate, truthful local feedback
- predicted effects reconcile or cancel without duplication
- fresh-launch rejoin and round restart clear effect histories, loops, tweens, and rumble
- strong events remain distinct from routine events
- effects never change authoritative outcomes
- camera and UI remain readable during the strongest combined event
- reduced-motion mode preserves all critical information
- desktop, touch, and gamepad paths feel deliberate
