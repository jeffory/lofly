import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHealth } from '../src/lib/health.ts';

const base = {
  playing: true, fps: 60, longFrames: 0, simLoad: 0.2, underruns: 0,
  softwareRenderer: null, contextLost: false, audioSuspended: false, autoReduced: null,
};
const at = (over) => assessHealth({ ...base, ...over });
const texts = (h) => h.messages.map(m => m.text).join(' | ');

test('a healthy session reports nothing', () => {
  const h = at({});
  assert.equal(h.level, 'ok');
  assert.deepEqual(h.messages, []);
});

test('idle never warns about audio, however bad the numbers look', () => {
  const h = at({ playing: false, simLoad: 3, underruns: 9, fps: 5 });
  assert.equal(h.level, 'ok');
});

test('high simulation load warns before anything is audible', () => {
  const h = at({ simLoad: 0.9 });
  assert.equal(h.level, 'warn');
  assert.match(texts(h), /90% of each bar/);
});

test('an underrun is critical and outranks the load warning', () => {
  const h = at({ simLoad: 0.9, underruns: 2 });
  assert.equal(h.level, 'critical');
  assert.match(texts(h), /fallen behind 2 times/);
  assert.doesNotMatch(texts(h), /of each bar/);
});

test('the remedy names the auto-reduced window once it has been applied', () => {
  assert.match(at({ underruns: 1 }).messages[0].remedy, /Lower "Brain time per bar"/);
  assert.match(at({ underruns: 1, autoReduced: 220 }).messages[0].remedy, /cut to 220 ms automatically/);
});

test('a software renderer is reported instead of the fps it causes', () => {
  const h = at({ softwareRenderer: 'SwiftShader', fps: 12 });
  assert.match(texts(h), /No GPU acceleration/);
  assert.doesNotMatch(texts(h), /fps/);
});

test('low fps is reported on its own when the GPU is real', () => {
  const h = at({ fps: 30 });
  assert.match(texts(h), /30 fps/);
  assert.match(h.messages[0].remedy, /audio is scheduled ahead and is not affected/);
});

test('every message carries a remedy', () => {
  const h = at({ simLoad: 0.95, underruns: 3, softwareRenderer: 'llvmpipe',
                 contextLost: true, audioSuspended: true });
  assert.equal(h.level, 'critical');
  assert.ok(h.messages.length >= 4);
  for (const m of h.messages) assert.ok(m.remedy.length > 10, `no remedy: ${m.text}`);
});
