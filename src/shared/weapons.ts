// Central weapon tuning table. Balancing lives here: the firing logic
// (physics.ts), damage (sim.ts), and HUD (client.ts) read these values.
// Weapons are selected via CLASSES (primary) below; everyone carries the
// pistol as the secondary.

export interface WeaponDef {
  name: string;
  damage: number; // body-shot damage (per pellet for pellet weapons)
  headshotMult: number; // damage multiplier on a head hit
  cooldownTicks: number; // ticks between shots (lower = faster fire)
  mag: number; // rounds per magazine
  reloadTicks: number; // reload duration (ticks)
  range: number; // hitscan range (metres)
  panelDamage: number; // damage to destructible cover per hit
  spreadBase: number; // bullet spread (radians) standing + grounded
  spreadMove: number; // extra spread added at full stride
  spreadAir: number; // extra spread added while airborne
  kick: number; // recoil: upward path deviation (radians) at full climb
  semiAuto?: boolean; // one shot per trigger pull (no hold-to-fire)
  pellets?: number; // pellet weapons fire this many rays per shot
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
    kick: 0.03,
  },
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
    kick: 0.042,
  },
  shotgun: {
    name: "Shotgun",
    damage: 12, // per pellet
    headshotMult: 1.5,
    cooldownTicks: 12,
    mag: 8,
    reloadTicks: 72,
    range: 26,
    panelDamage: 16, // per pellet — shreds cover up close
    spreadBase: 0.05,
    spreadMove: 0.07,
    spreadAir: 0.11,
    kick: 0.07,
    pellets: 7,
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
    kick: 0.09,
  },
  pistol: {
    name: "Pistol",
    damage: 20,
    headshotMult: 2,
    cooldownTicks: 3,
    mag: 12,
    reloadTicks: 36, // 1.2s — quick, that's the point of a sidearm
    range: 50,
    panelDamage: 6,
    spreadBase: 0.006,
    spreadMove: 0.014,
    spreadAir: 0.05,
    kick: 0.028,
    semiAuto: true,
  },
} satisfies Record<string, WeaponDef>;

export type WeaponId = keyof typeof WEAPONS;

// Wire/state indexing: weapons cross the network as WEAPON_LIST indices.
export const WEAPON_IDS = [
  "rifle",
  "smg",
  "shotgun",
  "sniper",
  "pistol",
] as const satisfies readonly WeaponId[];
export const WEAPON_LIST: readonly WeaponDef[] = WEAPON_IDS.map((id) => WEAPONS[id]);
export const WEAPON_IDX: Record<WeaponId, number> = Object.fromEntries(
  WEAPON_IDS.map((id, i) => [id, i]),
) as Record<WeaponId, number>;
export const PISTOL_IDX = WEAPON_IDX.pistol;

export function weaponByIdx(idx: number): WeaponDef {
  return WEAPON_LIST[idx] ?? WEAPONS.rifle;
}

// --- Classes: a primary weapon pick. Appearance stays team-only (red vs
// blue soldiers) — the class reads from the weapon in their hands. Everyone
// carries the pistol secondary, the sledgehammer, grenades, and build supply.
export interface ClassDef {
  name: string;
  primary: WeaponId;
  blurb: string; // one-liner for the class picker
}

export const CLASSES: readonly ClassDef[] = [
  { name: "Assault", primary: "rifle", blurb: "all-round rifle" },
  { name: "Raider", primary: "smg", blurb: "run & gun up close" },
  { name: "Breacher", primary: "shotgun", blurb: "door-kicking shredder" },
  { name: "Marksman", primary: "sniper", blurb: "one shot, one kill" },
];

export function classPrimaryIdx(classId: number): number {
  const cls = CLASSES[classId] ?? CLASSES[0];
  return WEAPON_IDX[cls.primary];
}

export const RIFLE = WEAPONS.rifle;
