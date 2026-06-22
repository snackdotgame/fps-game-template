// Shared timing, protocol, and gameplay constants. Client and server must
// agree on all of these.

import { RIFLE } from "./weapons.js";

export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

// Each input datagram redundantly carries the tail of recent unacked inputs.
export const INPUT_REDUNDANCY = 8;

// How far in the past remote players render.
export const REMOTE_DELAY_MS = 120;

export const MAX_PLAYERS = 16;

// Round flow: CONQUEST. Each team has a ticket pool; holding the zone
// majority bleeds the other team's tickets, every death costs one, and the
// round ends when a pool empties (or on the clock, higher pool wins).
export const ROUND_TICKS = 8 * 60 * TICK_RATE; // 8 minute rounds
export const RESULTS_TICKS = 10 * TICK_RATE;
export const TICKETS_START = 250;
export const ZONE_CAP_RATE = 0.55; // capture meter per tick per net attacker
export const BLEED_INTERVAL_TICKS = 60; // majority bleed cadence (2s)

// Player.
export const MAX_HP = 100;
export const RESPAWN_TICKS = 3 * TICK_RATE;
export const PROTECT_TICKS = 2 * TICK_RATE; // spawn protection
export const REGEN_DELAY_TICKS = 6 * TICK_RATE;
export const REGEN_PER_TICK = 0.5;

// Rifle (hitscan). Stats live in the shared weapon table (weapons.ts); these
// aliases keep the firing/HUD code stable while the table stays the source of
// truth for tuning and for the weapons we'll add next.
export const RIFLE_COOLDOWN_TICKS = RIFLE.cooldownTicks;
export const RIFLE_DAMAGE = RIFLE.damage;
export const RIFLE_PANEL_DAMAGE = RIFLE.panelDamage;
export const RIFLE_RANGE = RIFLE.range;
export const RIFLE_MAG = RIFLE.mag;
export const RELOAD_TICKS = RIFLE.reloadTicks;
// Spread (radians): base when still+grounded, worse moving / airborne.
export const SPREAD_BASE = RIFLE.spreadBase;
export const SPREAD_MOVE = RIFLE.spreadMove; // added at full stride
export const SPREAD_AIR = RIFLE.spreadAir; // added while airborne

// A bullet landing this high above the victim's feet (on the 1.6m collision
// capsule, head = its top hemisphere) counts as a headshot.
export const HEADSHOT_HEIGHT = 1.3;

// Grenades.
export const GRENADE_COUNT = 2;
export const GRENADE_FUSE_TICKS = 66; // ~2.2s
export const GRENADE_THROW_SPEED = 24;
export const GRENADE_RADIUS = 0.14;
export const EXPLOSION_RADIUS = 4.5;
export const EXPLOSION_MAX_DAMAGE = 120; // a direct blast is a guaranteed kill
export const EXPLOSION_MIN_DAMAGE = 32; // even the edge hurts
export const EXPLOSION_PANEL_RADIUS = 3.0; // pieces vaporized outright
export const EXPLOSION_IMPULSE = 11;

// Sledgehammer (melee, demolition).
export const MELEE_COOLDOWN_TICKS = 18;
export const MELEE_RANGE = 2.4;
export const MELEE_DAMAGE = 34;
export const MELEE_PANEL_DAMAGE = 50;

// Buildable cover.
export const BUILD_SUPPLY = 6; // per life
export const BUILD_RANGE = 3.0;
export const BUILD_COOLDOWN_TICKS = 12;

// Piece HP is per material (map.ts PANEL_HP); collapse fractions live
// per-structure in map.ts (buildings 0.35, trees 0.5).
// Explosions vaporize pieces inside EXPLOSION_PANEL_RADIUS and deal heavy
// damage out to EXPLOSION_PANEL_OUTER_RADIUS, so a grenade blows a sizable hole
// through wood/brick cover rather than just chipping it.
export const EXPLOSION_PANEL_OUTER_RADIUS = 5.0;
// Above brick/plank/sandbag HP, so the outer ring shatters wood/brick walls
// outright and heavily cracks concrete/metal — a grenade clears a real hole.
export const EXPLOSION_PANEL_OUTER_DAMAGE = 65;
export const RUBBLE_HEIGHT = 0.55;

export type Team = 0 | 1;
export const TEAM_NAMES = ["Orange", "Blue"];

// Bots fill the server up to this many participants so there's always
// something to fight; each joining human replaces one bot (and bots return
// as humans leave).
export const BOT_FILL = 12;

// Destruction/procgen test environment: no bots, no damage, bottomless
// ammo/grenades/supply. Flip on locally to iterate on the world without
// getting shot; MUST be false in commits (the playtest asserts bot fill).
export const SANDBOX = false;
