import {
  EXPLOSION_FULL_DAMAGE_RADIUS,
  EXPLOSION_MAX_DAMAGE,
  EXPLOSION_MIN_DAMAGE,
  EXPLOSION_RADIUS,
  explosionPlayerDamage,
} from "../src/shared/constants.js";

function closeTo(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

closeTo(explosionPlayerDamage(0), EXPLOSION_MAX_DAMAGE, "direct hit");
closeTo(
  explosionPlayerDamage(EXPLOSION_FULL_DAMAGE_RADIUS),
  EXPLOSION_MAX_DAMAGE,
  "near-direct edge",
);
closeTo(
  explosionPlayerDamage((EXPLOSION_FULL_DAMAGE_RADIUS + EXPLOSION_RADIUS) / 2),
  (EXPLOSION_MAX_DAMAGE + EXPLOSION_MIN_DAMAGE) / 2,
  "falloff midpoint",
);
closeTo(explosionPlayerDamage(EXPLOSION_RADIUS), EXPLOSION_MIN_DAMAGE, "blast edge");
closeTo(explosionPlayerDamage(EXPLOSION_RADIUS + 0.001), 0, "outside blast");

let previous = Number.POSITIVE_INFINITY;
for (let distance = 0; distance <= EXPLOSION_RADIUS; distance += 0.05) {
  const damage = explosionPlayerDamage(distance);
  if (damage > previous + 1e-6) {
    throw new Error(`damage increased from ${previous} to ${damage} at ${distance.toFixed(2)}m`);
  }
  if (damage < EXPLOSION_MIN_DAMAGE || damage > EXPLOSION_MAX_DAMAGE) {
    throw new Error(`damage ${damage} escaped the in-radius bounds at ${distance.toFixed(2)}m`);
  }
  previous = damage;
}

console.log(
  `grenade curve ok: ${EXPLOSION_MAX_DAMAGE} damage through ${EXPLOSION_FULL_DAMAGE_RADIUS}m, ` +
    `${EXPLOSION_MIN_DAMAGE} damage at ${EXPLOSION_RADIUS}m`,
);
