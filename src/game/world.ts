/**
 * A side-scrolling room the fly flies through, which stimulates it by collision.
 *
 * Pure state and physics, no canvas and no audio, so the rules can be tested
 * without a browser. `step` returns the sensory events the flight produced; the
 * caller decides what to do with them.
 *
 * Two deliberate departures from the obvious Flappy Bird shape:
 *
 * - Hitting something does not end the run. This is a music generator before it
 *   is a game, and death would stop the song mid-bar. A hit is a bump: it fires
 *   `touch`, costs a little height and momentum, and the flight continues.
 * - Obstacles are sparse and the gaps are generous. The interesting output comes
 *   from collecting different senses in different orders, not from precision.
 */

export type Sense = 'threat' | 'smell' | 'warmth' | 'touch' | 'buzz' | 'taste';

/** World units are fractions of the viewport height, so rendering can scale freely. */
export const WORLD = {
  gravity: 1.3,
  flap: -0.54,
  maxFall: 0.9,
  scrollSpeed: 0.34,
  flyX: 0.26,
  flyRadius: 0.045,
  /** Seconds of immunity after a bump, so one obstacle cannot fire repeatedly. */
  bumpCooldown: 0.9,
  obstacleEvery: 2.3,
  pickupEvery: 2.2,
  gapHalfHeight: 0.28,
};

export type Obstacle = { x: number; gapCentre: number; hit: boolean; passed: boolean };
export type Pickup = { x: number; y: number; sense: Sense; taken: boolean };

export type World = {
  y: number;
  vy: number;
  distance: number;
  bumps: number;
  /** Columns cleared without touching them. The reward signal. */
  passed: number;
  collected: Record<Sense, number>;
  obstacles: Obstacle[];
  pickups: Pickup[];
  sinceObstacle: number;
  sincePickup: number;
  cooldown: number;
  /** Contact is an edge trigger: resting against a wall must not re-fire. */
  onWall: boolean;
  /** Deterministic generator so a seed replays the same room. */
  seed: number;
};

/** Senses a pickup can carry. `touch` is excluded: that one you earn by crashing. */
export const PICKUP_SENSES: Sense[] = ['threat', 'smell', 'warmth', 'buzz', 'taste'];

export function createWorld(seed = 1): World {
  return {
    y: 0.5, vy: 0, distance: 0, bumps: 0, passed: 0,
    collected: { threat: 0, smell: 0, warmth: 0, touch: 0, buzz: 0, taste: 0 },
    obstacles: [], pickups: [],
    sinceObstacle: WORLD.obstacleEvery * 0.55,
    sincePickup: 0, cooldown: 0, onWall: false, seed: seed >>> 0 || 1,
  };
}

const random = (w: World) => {
  w.seed = (w.seed * 1664525 + 1013904223) >>> 0;
  return w.seed / 4294967296;
};

export function flap(w: World) {
  w.vy = WORLD.flap;
}

/**
 * Advance by `dt` seconds. Returns the senses triggered during this step, in
 * the order they happened.
 */
export function step(w: World, dt: number): Sense[] {
  const fired: Sense[] = [];
  const d = Math.min(dt, 0.05);   // a long frame must not teleport the fly through a wall

  w.vy = Math.min(WORLD.maxFall, w.vy + WORLD.gravity * d);
  w.y += w.vy * d;
  w.distance += WORLD.scrollSpeed * d;
  w.cooldown = Math.max(0, w.cooldown - d);

  // The ceiling and floor are walls. Contact fires on arrival only: a fly that
  // has settled on the floor is not being touched again every cooldown.
  const r = WORLD.flyRadius;
  const hitCeiling = w.y < r, hitFloor = w.y > 1 - r;
  if (hitCeiling) { w.y = r; w.vy = 0; }
  if (hitFloor) { w.y = 1 - r; w.vy = 0; }
  const onWall = hitCeiling || hitFloor;
  // Edge-triggered AND rate-limited. The edge alone is not enough: a fly
  // bouncing along the ceiling re-crosses the boundary every few frames, which
  // measured at ~100 "touches" a minute and drowned everything else out.
  if (onWall && !w.onWall && !w.cooldown) {
    fired.push('touch'); w.bumps++; w.cooldown = WORLD.bumpCooldown;
  }
  w.onWall = onWall;

  w.sinceObstacle += d;
  if (w.sinceObstacle >= WORLD.obstacleEvery) {
    w.sinceObstacle = 0;
    w.obstacles.push({ x: 1.1, gapCentre: 0.28 + random(w) * 0.44, hit: false, passed: false });
  }
  w.sincePickup += d;
  if (w.sincePickup >= WORLD.pickupEvery) {
    w.sincePickup = 0;
    w.pickups.push({
      x: 1.1, y: 0.15 + random(w) * 0.7,
      sense: PICKUP_SENSES[Math.floor(random(w) * PICKUP_SENSES.length)],
      taken: false,
    });
  }

  const move = WORLD.scrollSpeed * d;
  for (const o of w.obstacles) {
    const before = o.x;
    o.x -= move;
    // Cleared once the column is fully behind the fly and was never struck.
    if (!o.passed && before - 0.055 >= WORLD.flyX && o.x - 0.055 < WORLD.flyX) {
      o.passed = true;
      if (!o.hit) w.passed++;
    }
    // Column occupies a band in x; the gap is the safe corridor.
    const near = Math.abs(o.x - WORLD.flyX) < 0.055 + r;
    if (near && !o.hit && !w.cooldown &&
        Math.abs(w.y - o.gapCentre) > WORLD.gapHalfHeight - r) {
      o.hit = true;
      w.bumps++;
      w.cooldown = WORLD.bumpCooldown;
      // Nudge the fly back toward the gap so a bump is survivable, not a trap.
      w.vy = w.y > o.gapCentre ? -0.35 : 0.35;
      fired.push('touch');
    }
  }
  for (const p of w.pickups) {
    p.x -= move;
    if (!p.taken && Math.hypot(p.x - WORLD.flyX, p.y - w.y) < r + 0.035) {
      p.taken = true;
      w.collected[p.sense]++;
      fired.push(p.sense);
    }
  }
  w.obstacles = w.obstacles.filter(o => o.x > -0.15);
  w.pickups = w.pickups.filter(p => p.x > -0.15 && !p.taken);

  return fired;
}
