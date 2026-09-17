import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/game/world.ts';
import { createPilot, fly, observe, TRAINED, EPISODE } from '../src/game/pilot.ts';

const dt = 1 / 60;
const flyFor = (weights, seconds, seed) => {
  const w = createWorld(seed);
  const p = createPilot(1); p.trial = weights;
  for (let t = 0; t < seconds; t += dt) { p.elapsed = 0; fly(p, w, dt, 0); }   // no episode rollover
  return w;
};

test('the trained pilot clears columns without crashing', () => {
  let passed = 0, bumps = 0;
  for (const seed of [90001, 90002, 90003, 90004]) {
    const w = flyFor(TRAINED, 30, seed);
    passed += w.passed; bumps += w.bumps;
  }
  assert.ok(passed >= 30, `expected to clear columns, got ${passed}`);
  assert.equal(bumps, 0, `trained pilot should not crash, got ${bumps} bumps`);
});

test('doing nothing is much worse, so the weights are doing the work', () => {
  const idle = flyFor([0, 0, 0, 0], 30, 90001);
  const trained = flyFor(TRAINED, 30, 90001);
  assert.ok(trained.passed > idle.passed, 'trained should clear more');
  assert.ok(trained.bumps < idle.bumps, 'trained should crash less');
});

test('observation is finite and signed the way the policy expects', () => {
  const w = createWorld(3);
  w.y = 0.9;   // below a mid-room gap
  const below = observe(w, 0)[0];
  w.y = 0.1;   // above it
  const above = observe(w, 0)[0];
  assert.ok(Number.isFinite(below) && Number.isFinite(above));
  assert.ok(below > above, 'the gap-offset term must grow as the fly sinks');
});

test('an episode boundary records fitness and proposes new weights', () => {
  const w = createWorld(5);
  const p = createPilot(7);
  const before = [...p.trial];
  for (let t = 0; t <= EPISODE + dt; t += dt) fly(p, w, dt, 0);
  assert.equal(p.episode, 1);
  assert.equal(p.history.length, 1);
  assert.notDeepEqual(p.trial, before, 'a fresh perturbation should have been drawn');
});

test('learning keeps the better of the two and never loses the best', () => {
  const w = createWorld(9);
  const p = createPilot(3);
  p.bestScore = 1000;                 // nothing will beat this
  const keep = [...p.best];
  for (let t = 0; t <= EPISODE + dt; t += dt) fly(p, w, dt, 0);
  assert.deepEqual(p.best, keep, 'a worse episode must not overwrite the best');
});
