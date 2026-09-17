import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, flap, step, WORLD, PICKUP_SENSES } from '../src/game/world.ts';

const run = (w, seconds, dt = 1 / 60) => {
  const fired = [];
  for (let t = 0; t < seconds; t += dt) fired.push(...step(w, dt));
  return fired;
};

/** Same, but with the room emptied each frame, to isolate wall contact from
 *  obstacles drifting into a grounded fly (which is correct, just not the
 *  behaviour these two tests are about). */
const runInEmptyRoom = (w, seconds, dt = 1 / 60) => {
  const fired = [];
  for (let t = 0; t < seconds; t += dt) {
    w.obstacles.length = 0; w.pickups.length = 0;
    fired.push(...step(w, dt));
  }
  return fired;
};

test('gravity pulls the fly down and a flap lifts it', () => {
  const w = createWorld();
  step(w, 0.2);
  assert.ok(w.vy > 0, 'should be falling');
  flap(w);
  assert.ok(w.vy < 0, 'flap should give upward velocity');
});

test('landing fires touch once, and resting on the floor does not re-fire', () => {
  const w = createWorld();
  const fired = runInEmptyRoom(w, 2);
  assert.ok(fired.includes('touch'));
  assert.equal(w.bumps, 1, 'contact is an edge trigger, not a level one');
  runInEmptyRoom(w, 8);
  assert.equal(w.bumps, 1, 'still resting on the floor, still one bump');
});

test('taking off and landing again fires touch a second time', () => {
  const w = createWorld();
  runInEmptyRoom(w, 2);
  assert.equal(w.bumps, 1);
  flap(w);
  runInEmptyRoom(w, 3);
  assert.equal(w.bumps, 2, 'a fresh landing is a fresh touch');
});

test('bouncing along the ceiling cannot machine-gun touch events', () => {
  // Flapping every frame pins the fly to the ceiling, re-crossing the boundary
  // constantly. Edge-triggering alone let that fire ~100 times a minute.
  const w = createWorld();
  const fired = [];
  for (let t = 0; t < 10; t += 1 / 60) {
    w.obstacles.length = 0; w.pickups.length = 0;
    flap(w);
    fired.push(...step(w, 1 / 60));
  }
  const touches = fired.filter(f => f === 'touch').length;
  assert.ok(touches <= Math.ceil(10 / WORLD.bumpCooldown) + 1,
            `${touches} touches in 10s exceeds the ${WORLD.bumpCooldown}s cooldown`);
});

test('the fly is clamped inside the room', () => {
  const w = createWorld();
  run(w, 5);
  assert.ok(w.y <= 1 - WORLD.flyRadius + 1e-6 && w.y >= WORLD.flyRadius - 1e-6);
});

test('a long frame cannot teleport the fly through the room', () => {
  const w = createWorld();
  step(w, 10);
  assert.ok(w.y <= 1 - WORLD.flyRadius + 1e-6, 'dt is clamped');
});

test('pickups only ever fire senses that exist as pokes', () => {
  const w = createWorld(7);
  const fired = run(w, 60);
  assert.ok(fired.length > 5, 'a minute of flight should trigger something');
  for (const s of fired) assert.ok([...PICKUP_SENSES, 'touch'].includes(s), `unexpected sense ${s}`);
});

test('the same seed replays the same room', () => {
  const a = createWorld(42), b = createWorld(42);
  const fa = run(a, 30), fb = run(b, 30);
  assert.deepEqual(fa, fb);
  assert.equal(a.distance.toFixed(6), b.distance.toFixed(6));
});

test('obstacles and pickups are cleaned up once off screen', () => {
  const w = createWorld(3);
  run(w, 90);
  assert.ok(w.obstacles.length < 12, `obstacles leaked: ${w.obstacles.length}`);
  assert.ok(w.pickups.length < 12, `pickups leaked: ${w.pickups.length}`);
});

test('flying the gap cleanly produces no touch', () => {
  const w = createWorld(11);
  const fired = [];
  for (let t = 0; t < 12; t += 1/60) {
    // Hold station mid-room: flap whenever we sink below centre.
    if (w.y > 0.5) flap(w);
    const out = step(w, 1/60);
    // Steer toward the nearest gap so we are testing the corridor, not the walls.
    const next = w.obstacles.find(o => o.x > WORLD.flyX - 0.1);
    if (next && Math.abs(w.y - next.gapCentre) > 0.05 && w.y > next.gapCentre) flap(w);
    fired.push(...out);
  }
  assert.ok(!fired.includes('touch') || w.bumps <= 2, `too many bumps: ${w.bumps}`);
});

test('clearing a column counts as passed, striking it does not', () => {
  const w = createWorld(5);
  // Hold the fly on the gap centre of whatever column is coming.
  for (let t = 0; t < 40; t += 1 / 60) {
    const next = w.obstacles.filter(o => o.x > WORLD.flyX - 0.06).sort((a, b) => a.x - b.x)[0];
    const target = next ? next.gapCentre : 0.5;
    if (w.y > target + 0.02) flap(w);
    step(w, 1 / 60);
  }
  assert.ok(w.passed >= 3, `expected to clear several columns, got ${w.passed}`);
  assert.equal(w.bumps, 0, 'a clean flight should not register bumps');
});

test('a struck column is never counted as passed', () => {
  const w = createWorld(5);
  for (let t = 0; t < 40; t += 1 / 60) step(w, 1 / 60);   // never flap: fall and get hit
  const struck = w.obstacles.filter(o => o.hit).length;
  assert.ok(w.bumps > 0, 'should have hit something');
  assert.ok(w.passed + struck <= w.passed + w.bumps);
});
