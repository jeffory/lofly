/** Confirm the shipped defaults: 8-bar progression + cycling, via the fast kernel. */
import { readFileSync } from 'node:fs';
import { buildChannels, resolveTypes, STIMULI, stimulusForBar } from '../src/sim/circuits.ts';
import { composeBar, MOODS, VOICES } from '../src/audio/composer.ts';

const dir = new URL('../public/data/connectome/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8'));
const wasm = readFileSync(new URL('../wasm/target/wasm32-unknown-unknown/release/lif_wasm.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const w = instance.exports;
const put = b => { const p = w.lf_alloc(b.length); new Uint8Array(w.memory.buffer).set(b, p); return p; };
const pI = put(readFileSync(new URL('indptr.bin', dir))), pX = put(readFileSync(new URL('indices.bin', dir)));
const pW = put(readFileSync(new URL('weights.bin', dir))), pV = put(readFileSync(new URL('viewer_map.bin', dir)));
w.lf_init(meta.nodes, meta.edges, meta.viewerRows, 0.2, pI, pX, pW, pV);

const channels = buildChannels(meta);
const sizes = new Map(channels.map(c => [c.name, c.neurons.length]));
w.lf_clear_channels();
channels.forEach((ch, c) => ch.neurons.forEach((n, s) => w.lf_set_channel(n, c, s)));
const stimPtrs = new Map();
for (const spec of STIMULI) {
  const idx = resolveTypes(meta, spec.types);
  const p = w.lf_alloc(idx.length * 4);
  new Uint32Array(w.memory.buffer, p, idx.length).set(idx);
  stimPtrs.set(spec.key, [p, idx.length]);
}

const BAR = 2.5, BRAIN = 400;
const jac = (a, b) => { if (!a.size && !b.size) return 1; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

function run(mood, cycling, cycleBars, bars = 24) {
  w.lf_reset();
  const out = [];
  for (let bar = 0; bar < bars; bar++) {
    const key = cycling ? stimulusForBar(bar, cycleBars) : 'pIP10';
    const [ptr, len] = stimPtrs.get(key);
    const n = w.lf_simulate(BRAIN, ptr, len, 150, 0.35, channels.length, 40000);
    const packed = new Uint32Array(w.memory.buffer, w.lf_events_ptr(), n * 2);
    const byChannel = new Map();
    for (let i = 0; i < n; i++) {
      const name = channels[packed[i*2] >>> 16]?.name; if (!name) continue;
      const e = { slot: packed[i*2] & 0xffff, at: packed[i*2+1] * 0.2 };
      const l = byChannel.get(name); if (l) l.push(e); else byChannel.set(name, [e]);
    }
    const notes = composeBar({ byChannel, channelSize: sizes, brainMs: BRAIN, barSeconds: BAR,
      bar, intensity: 1, scale: mood.scale, progression: mood.progression });
    const on = new Map(), pi = new Map();
    for (const v of VOICES) { on.set(v.role, new Set()); pi.set(v.role, new Set()); }
    for (const nt of notes) { on.get(nt.role).add(Math.round((nt.at / BAR) * 16)); if (nt.midi) pi.get(nt.role).add(nt.midi); }
    out.push({ on, pi, notes: notes.length });
  }
  return out;
}
function rep(bars, lag) {
  let r = 0, p = 0, nr = 0, np = 0;
  for (let i = lag; i < bars.length; i++) for (const v of VOICES) {
    r += jac(bars[i].on.get(v.role), bars[i-lag].on.get(v.role)); nr++;
    if (v.span > 0) { p += jac(bars[i].pi.get(v.role), bars[i-lag].pi.get(v.role)); np++; }
  }
  return [r/nr, p/np];
}

const mood = MOODS[0];
console.log('shipped defaults: 8-bar progression, 4 stimuli x 4 bars\n');
console.log('config                                 lag4 rhythm/pitch   lag8 rhythm/pitch  notes');
for (const [label, cyc, cb] of [['fixed pIP10 (old behaviour)', false, 4],
                                ['cycle every 4 bars (default)', true, 4],
                                ['cycle every 3 bars', true, 3],
                                ['cycle every 2 bars', true, 2]]) {
  const bars = run(mood, cyc, cb);
  const [r4, p4] = rep(bars, 4), [r8, p8] = rep(bars, 8);
  const avg = bars.reduce((a, b) => a + b.notes, 0) / bars.length;
  console.log(`${label.padEnd(38)} ${r4.toFixed(2)} / ${p4.toFixed(2)}        ${r8.toFixed(2)} / ${p8.toFixed(2)}       ${avg.toFixed(0)}`);
}
