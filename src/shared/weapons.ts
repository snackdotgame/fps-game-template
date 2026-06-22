// Central weapon tuning table. Balancing lives here: the firing logic
// (physics.ts), damage (sim.ts), and HUD (client.ts) read these values. Adding
// a weapon is a new entry here plus a per-player selection (coming soon) —
// today the rifle is the only one wired up, but the others are kept ready so
// dropping them in is a one-liner.

export interface WeaponDef {
  name: string;
  damage: number; // body-shot damage
  headshotMult: number; // damage multiplier on a head hit
  cooldownTicks: number; // ticks between shots (lower = faster fire)
  mag: number; // rounds per magazine
  reloadTicks: number; // reload duration (ticks)
  range: number; // hitscan range (metres)
  panelDamage: number; // damage to destructible cover per hit
  spreadBase: number; // bullet spread (radians) standing + grounded
  spreadMove: number; // extra spread added at full stride
  spreadAir: number; // extra spread added while airborne
}

export const WEAPONS = {
  rifle: {
    name: "Rifle",
    damage: 25,
    headshotMult: 2,
    cooldownTicks: 4, // 7.5 rounds/s
    mag: 30,
    reloadTicks: 54, // 1.8s
    range: 90,
    panelDamage: 12,
    spreadBase: 0.004,
    spreadMove: 0.011,
    spreadAir: 0.045,
  },
  // --- Not yet selectable; here so balancing a future loadout is one edit. ---
  smg: {
    name: "SMG",
    damage: 16,
    headshotMult: 1.8,
    cooldownTicks: 2, // 15 rounds/s
    mag: 35,
    reloadTicks: 48,
    range: 55,
    panelDamage: 7,
    spreadBase: 0.01,
    spreadMove: 0.022,
    spreadAir: 0.06,
  },
  shotgun: {
    name: "Shotgun",
    damage: 12, // per pellet (future: fires a spread of pellets)
    headshotMult: 1.5,
    cooldownTicks: 12,
    mag: 8,
    reloadTicks: 72,
    range: 24,
    panelDamage: 16,
    spreadBase: 0.05,
    spreadMove: 0.07,
    spreadAir: 0.11,
  },
  sniper: {
    name: "Sniper",
    damage: 80,
    headshotMult: 2.5,
    cooldownTicks: 30,
    mag: 5,
    reloadTicks: 84,
    range: 220,
    panelDamage: 22,
    spreadBase: 0.0005,
    spreadMove: 0.03,
    spreadAir: 0.13,
  },
} satisfies Record<string, WeaponDef>;

export type WeaponId = keyof typeof WEAPONS;

// The single weapon wired up today.
export const RIFLE = WEAPONS.rifle;
