/** Do the proposed new stimuli actually drive anything downstream? */
import { readFileSync } from 'node:fs';
import { buildChannels, resolveTypes } from '../src/sim/circuits.ts';

const dir = new URL('../public/data/connectome/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8'));
const wasm = readFileSync(new URL('../wasm/target/wasm32-unknown-unknown/release/lif_wasm.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const w = instance.exports;
const put = b => { const p = w.lf_alloc(b.length); new Uint8Array(w.memory.buffer).set(b, p); return p; };
const a = put(readFileSync(new URL('indptr.bin', dir))), b2 = put(readFileSync(new URL('indices.bin', dir)));
const c2 = put(readFileSync(new URL('weights.bin', dir))), d2 = put(readFileSync(new URL('viewer_map.bin', dir)));
w.lf_init(meta.nodes, meta.edges, meta.viewerRows, 0.2, a, b2, c2, d2);

// Watch the existing song voices plus the new candidates.
const watch = [...buildChannels(meta),
  { name: 'PFL3', neurons: resolveTypes(meta, ['PFL3']) },
  { name: 'LC10', neurons: resolveTypes(meta, ['LC10']) },
  { name: 'MDN', neurons: resolveTypes(meta, ['MDN']) },
  { name: 'legMN', neurons: resolveTypes(meta, ['Ta depressor MN','Ta levator MN','Fe reductor MN']) },
];
w.lf_clear_channels();
watch.forEach((ch, ci) => ch.neurons.forEach((n, s) => w.lf_set_channel(n, ci, s)));

const TRY = [
  ['pIP10 (current)', ['pIP10']],
  ['ORN_DA1 (cVA pheromone)', ['ORN_DA1']],
  ['all ORNs', ['ORN_']],
  ['LPLC2 (looming)', ['LPLC2']],
  ['EPG (compass)', ['EPG']],
];
console.log('stimulus                   ' + watch.map(c => c.name.slice(0,6).padStart(7)).join(''));
for (const [label, types] of TRY) {
  const idx = resolveTypes(meta, types);
  const p = w.lf_alloc(idx.length * 4);
  new Uint32Array(w.memory.buffer, p, idx.length).set(idx);
  w.lf_reset();
  let rates = new Float32Array(watch.length);
  for (let bar = 0; bar < 6; bar++) {
    w.lf_simulate(400, p, idx.length, 150, 0.35, watch.length, 40000);
    const r = new Float32Array(w.memory.buffer, w.lf_rates_ptr(), watch.length);
    if (bar >= 2) for (let i = 0; i < rates.length; i++) rates[i] += r[i] / 4;
  }
  const cells = watch.map((c, i) => (c.neurons.length ? rates[i] / c.neurons.length : 0).toFixed(0).padStart(7)).join('');
  console.log(`${(label + ` (${idx.length})`).padEnd(27)}${cells}`);
}
console.log('\n(per-neuron Hz in each watched population)');
