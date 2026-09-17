/**
 * A pilot that learns to fly the room.
 *
 * The policy is a four-weight linear rule — flap when `w · x > 0` — trained by
 * a (1+1) evolution strategy: perturb the current weights, fly a stretch, keep
 * the perturbation only if it scored better. No gradients, no backprop, and it
 * runs inside the same frame loop as the game.
 *
 * Why so small: the reward here is sparse and noisy (a column cleared, a bump
 * taken) and episodes are seconds long. Four parameters can be searched in a
 * handful of episodes; anything larger would still be flailing when a listener
 * has already wandered off.
 *
 * What this is NOT: the connectome learning to fly. The brain runs at roughly
 * 400 ms of brain time per 2.5 s bar, so its state updates about once a bar —
 * far too slow to close a control loop that needs decisions several times a
 * second. `brainDrive` lets the brain bias the policy on that slow channel, so
 * flight and connectome genuinely influence each other, but the fast control is
 * this linear rule and it is the rule that learns.
 */
import { flap, step, WORLD, type Sense, type World } from './world.ts';

export type Weights = [number, number, number, number];

export type Pilot = {
  best: Weights;
  trial: Weights;
  /** Reward accumulated by the trial weights so far. */
  score: number;
  bestScore: number;
  elapsed: number;
  episode: number;
  /** Perturbation size, annealed as the pilot improves. */
  sigma: number;
  seed: number;
  /** Fitness of the last few episodes, for display. */
  history: number[];
};

/** Seconds of flight per episode before the trial is judged. */
export const EPISODE = 14;
const SIGMA_START = 0.9;
const SIGMA_MIN = 0.12;

/**
 * Weights found by running this same search offline across six seeds and
 * keeping the best on held-out rooms: 16 columns cleared and 0 bumps per 40 s.
 *
 * They are a starting point, not a finished answer — learning continues online
 * from here. Starting from zero works too and takes 28–140 s of flight to
 * become competent, which is a long time to watch a fly fall over; pass
 * `fromScratch` to do exactly that and watch it happen.
 */
export const TRAINED: Weights = [2.251, 0.136, 0.051, 0.794];

export function createPilot(seed = 12345, fromScratch = false): Pilot {
  const start: Weights = fromScratch ? [0, 0, 0, 0] : [...TRAINED] as Weights;
  return {
    best: [...start] as Weights, trial: [...start] as Weights,
    score: 0, bestScore: -Infinity, elapsed: 0, episode: 0,
    sigma: SIGMA_START, seed: seed >>> 0 || 1, history: [],
  };
}

const rnd = (p: Pilot) => {
  p.seed = (p.seed * 1664525 + 1013904223) >>> 0;
  return p.seed / 4294967296;
};
/** Box-Muller, so perturbations are gaussian rather than boxy. */
const gauss = (p: Pilot) =>
  Math.sqrt(-2 * Math.log(1 - rnd(p))) * Math.cos(2 * Math.PI * rnd(p));

/** Room widths from the near column within which the pilot starts leaning
 *  toward the gap after it. */
const HANDOVER = 0.15;
/** How far it leans, at most. Measured against the smooth weights: 0.2 cut
 *  target snaps from 11.6 to 7.9 a minute with no bumps; 0.3 began costing
 *  bumps, and 0.5 cost 2.8 a minute. */
const LEAN = 0.2;

/**
 * What the pilot sees: gap offset, fall speed, closing distance, brain.
 *
 * The gap offset looks one column further than the nearest. Using only the
 * nearest snapped the target to the next gap the instant a column passed. The
 * first attempt at blending weighted the near column MORE as it approached,
 * which collapses to "nearest" at exactly the moment it matters and measured
 * as no change at all. The lean has to go the other way: as the column
 * arrives, the fly is committed through it, so the target shifts toward what
 * comes next.
 *
 * Pickups are deliberately not in here. A version that saw them collected 47%
 * at three times the jerk; making the room spawn them near the path and
 * widening the catch radius collects 64% with the flight untouched.
 */
export function observe(w: World, brainDrive: number): Weights {
  const ahead = w.obstacles
    .filter(o => o.x + 0.055 > WORLD.flyX)
    .sort((a, b) => a.x - b.x);
  const [a, b] = ahead;
  let target = 0.5, dx = 1;
  if (a) {
    dx = Math.min(1, (a.x - WORLD.flyX) / 0.8);
    target = a.gapCentre;
    if (b) {
      const d = a.x - WORLD.flyX;
      const lean = d < HANDOVER ? (1 - d / HANDOVER) * LEAN : 0;
      target = a.gapCentre * (1 - lean) + b.gapCentre * lean;
    }
  }
  return [
    (w.y - target) * 3,      // positive when below the gap, so flapping should help
    w.vy * 1.4,
    dx,
    brainDrive,
  ];
}

const dot = (a: Weights, b: Weights) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];

/** Decide and act for one frame. Returns the senses the step produced. */
export function fly(p: Pilot, w: World, dt: number, brainDrive: number): Sense[] {
  if (dot(p.trial, observe(w, brainDrive)) > 0) flap(w);

  const before = { passed: w.passed, bumps: w.bumps };
  const fired = step(w, dt);
  // Clearing a column and taking a pickup are each worth one; a bump costs
  // three, otherwise the pilot learns to barge through everything. Pickups
  // count even though the pilot cannot see them: the room places them near the
  // path, so a pilot that holds its line well is rewarded for it.
  const picked = fired.filter(f => f !== 'touch').length;
  p.score += (w.passed - before.passed) + picked - (w.bumps - before.bumps) * 3;
  p.elapsed += dt;

  if (p.elapsed >= EPISODE) {
    p.history.push(p.score);
    if (p.history.length > 40) p.history.shift();
    if (p.score > p.bestScore) {
      p.bestScore = p.score;
      p.best = [...p.trial] as Weights;
      p.sigma = Math.max(SIGMA_MIN, p.sigma * 0.92);   // converging: search finer
    } else {
      p.sigma = Math.min(SIGMA_START, p.sigma * 1.05); // stuck: widen again
    }
    p.trial = p.best.map(v => v + gauss(p) * p.sigma) as Weights;
    p.score = 0;
    p.elapsed = 0;
    p.episode++;
  }
  return fired;
}
