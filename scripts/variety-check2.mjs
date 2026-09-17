/** Does going from 4 to 7 stimuli actually reduce repetition further? */
import { readFileSync } from 'node:fs';
import { buildChannels, resolveTypes, STIMULI, CYCLE_ORDER } from '../src/sim/circuits.ts';
import { composeBar, MOODS } from '../src/audio/composer.ts';
import { KITS } from '../src/audio/kits.ts';

const dir = new URL('../public/data/connectome/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8'));
const wasm = readFileSync(new URL('../wasm/target/wasm32-unknown-unknown/release/lif_wasm.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const w = instance.exports;
const put = b => { const p = w.lf_alloc(b.length); new Uint8Array(w.memory.buffer).set(b, p); return p; };
const a = put(readFileSync(new URL('indptr.bin', dir))), b2 = put(readFileSync(new URL('indices.bin', dir)));
const c2 = put(readFileSync(new URL('weights.bin', dir))), d2 = put(readFileSync(new URL('viewer_map.bin', dir)));
w.lf_init(meta.nodes, meta.edges, meta.viewerRows, 0.2, a, b2, c2, d2);
const channels = buildChannels(meta);
const sizes = new Map(channels.map(c => [c.name, c.neurons.length]));
w.lf_clear_channels();
channels.forEach((ch, ci) => ch.neurons.forEach((n, s) => w.lf_set_channel(n, ci, s)));
const stim = new Map();
for (const s of STIMULI) { const i = resolveTypes(meta, s.types); const p = w.lf_alloc(i.length*4);
  new Uint32Array(w.memory.buffer, p, i.length).set(i); stim.set(s.key, [p, i.length]); }
const kit = KITS[0], mood = MOODS[0];
const jac = (x, y) => { if (!x.size && !y.size) return 1; let i=0; for (const v of x) if (y.has(v)) i++; return i/(x.size+y.size-i); };

function run(order, step, bars) {
  w.lf_reset();
  const out = [];
  for (let bar = 0; bar < bars; bar++) {
    const [p, len] = stim.get(order[Math.floor(bar/step) % order.length]);
    const n = w.lf_simulate(400, p, len, 150, 0.35, channels.length, 40000);
    const packed = new Uint32Array(w.memory.buffer, w.lf_events_ptr(), n*2);
    const byChannel = new Map();
    for (let i = 0; i < n; i++) { const nm = channels[packed[i*2]>>>16]?.name; if (!nm) continue;
      const e = { slot: packed[i*2]&0xffff, at: packed[i*2+1]*0.2 };
      const l = byChannel.get(nm); if (l) l.push(e); else byChannel.set(nm, [e]); }
    const notes = composeBar({ byChannel, channelSize: sizes, brainMs: 400, barSeconds: 2.5,
      bar, intensity: 1, kit, scale: mood.scale, progression: mood.progression });
    const on = new Map(), pi = new Map();
    for (const v of kit.voices) { on.set(v.role, new Set()); pi.set(v.role, new Set()); }
    for (const nt of notes) { on.get(nt.role).add(Math.round((nt.at/2.5)*16)); if (nt.midi) pi.get(nt.role).add(nt.midi); }
    out.push({ on, pi });
  }
  return out;
}
function rep(bars, lag) {
  let r=0,p=0,nr=0,np=0;
  for (let i=lag;i<bars.length;i++) for (const v of kit.voices) {
    r += jac(bars[i].on.get(v.role), bars[i-lag].on.get(v.role)); nr++;
    if (v.span>0) { p += jac(bars[i].pi.get(v.role), bars[i-lag].pi.get(v.role)); np++; }
  }
  return [r/nr, p/np];
}
console.log('cycle                       lag4          lag8          lag12');
for (const [label, order] of [['4 stimuli (before)', ['pIP10','JO','pC1','DNa']],
                              ['7 stimuli (now)', [...CYCLE_ORDER]]]) {
  const bars = run(order, 3, 30);
  const f = l => rep(bars, l).map(x => x.toFixed(2)).join('/');
  console.log(`${label.padEnd(26)} ${f(4).padEnd(13)} ${f(8).padEnd(13)} ${f(12)}`);
}
