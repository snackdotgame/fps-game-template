// Shared timing, protocol, and gameplay constants. Client and server must
// agree on all of these.

export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

// Each input datagram redundantly carries the tail of recent unacked inputs.
export const INPUT_REDUNDANCY = 8;

// How far in the past remote players render.
export const REMOTE_DELAY_MS = 120;

export const MAX_PLAYERS = 16;

// Round flow.
export const ROUND_TICKS = 5 * 60 * TICK_RATE; // 5 minute rounds
export const RESULTS_TICKS = 10 * TICK_RATE;
export const SCORE_LIMIT = 40; // team kills to win early

// Player.
export const MAX_HP = 100;
export const RESPAWN_TICKS = 3 * TICK_RATE;
export const PROTECT_TICKS = 2 * TICK_RATE; // spawn protection
export const REGEN_DELAY_TICKS = 6 * TICK_RATE;
export const REGEN_PER_TICK = 0.5;

// Rifle (hitscan).
export const RIFLE_COOLDOWN_TICKS = 4; // 7.5 rounds/s
export const RIFLE_DAMAGE = 16;
export const RIFLE_PANEL_DAMAGE = 10;
export const RIFLE_RANGE = 90;
export const RIFLE_MAG = 30;
export const RELOAD_TICKS = 54; // 1.8s
// Spread (radians): base when still+grounded, worse moving / airborne.
export const SPREAD_BASE = 0.004;
export const SPREAD_MOVE = 0.011; // added at full stride
export const SPREAD_AIR = 0.045; // added while airborne

// Grenades.
export const GRENADE_COUNT = 2;
export const GRENADE_FUSE_TICKS = 66; // ~2.2s
export const GRENADE_THROW_SPEED = 16;
export const GRENADE_RADIUS = 0.14;
export const EXPLOSION_RADIUS = 4.5;
export const EXPLOSION_MAX_DAMAGE = 95;
export const EXPLOSION_MIN_DAMAGE = 15;
export const EXPLOSION_PANEL_RADIUS = 3.2;
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

// Panels are 1m x 0.625m pieces now: 6 rifle hits or 2 sledge swings each.
// Collapse fractions live per-structure in map.ts (buildings 0.4, trees 0.5).
export const PANEL_HP = 60;
// Explosions delete panels inside EXPLOSION_PANEL_RADIUS and chip panels in
// an outer falloff ring.
export const EXPLOSION_PANEL_OUTER_RADIUS = 5.2;
export const EXPLOSION_PANEL_OUTER_DAMAGE = 50;
export const RUBBLE_HEIGHT = 0.55;

export type Team = 0 | 1;
export const TEAM_NAMES = ["Orange", "Blue"];

// Bots fill the server up to this many participants so there's always
// something to fight; each joining human replaces one bot (and bots return
// as humans leave).
export const BOT_FILL = 6;
