/** Does poking a sense organ drive the behaviour it should, and change the mix? */
import { readFileSync } from 'node:fs';
import { buildChannels, resolveTypes } from '../src/sim/circuits.ts';

const dir = new URL('../public/data/connectome/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8'));
const wasm = readFileSync(new URL('../wasm/target/wasm32-unknown-unknown/release/lif_wasm.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const w = instance.exports;
const put = b => { const p = w.lf_alloc(b.length); new Uint8Array(w.memory.buffer).set(b, p); return p; };
const a=put(readFileSync(new URL('indptr.bin',dir))), b2=put(readFileSync(new URL('indices.bin',dir)));
const c2=put(readFileSync(new URL('weights.bin',dir))), d2=put(readFileSync(new URL('viewer_map.bin',dir)));
w.lf_init(meta.nodes, meta.edges, meta.viewerRows, 0.2, a, b2, c2, d2);

// Voices, plus behavioural readouts we expect a poke to move.
const watch = [...buildChannels(meta),
  { name: 'MN9prob', neurons: resolveTypes(meta, ['MN9', 'MN11', 'MN12']) },
  { name: 'DNp01',   neurons: resolveTypes(meta, ['DNp01']) },
  { name: 'MDN',     neurons: resolveTypes(meta, ['MDN']) },
  { name: 'legMN',   neurons: resolveTypes(meta, ['Ta depressor MN','Ta levator MN','Fe reductor MN']) },
];
w.lf_clear_channels();
watch.forEach((ch, ci) => ch.neurons.forEach((n, s) => w.lf_set_channel(n, ci, s)));

const POKES = [
  ['baseline (pIP10 only)', null],
  ['Food  (BM_Taste)',      ['BM_Taste']],
  ['Smell (all ORNs)',      ['ORN_']],
  ['Touch (BM_InOm)',       ['BM_InOm']],
  ['Heat  (TRN_VP)',        ['TRN_VP']],
  ['Threat (LPLC2)',        ['LPLC2']],
  ['Buzz  (BM_Vib)',        ['BM_Vib']],
];
const bg = resolveTypes(meta, ['pIP10']);
const pBg = w.lf_alloc(bg.length * 4);
new Uint32Array(w.memory.buffer, pBg, bg.length).set(bg);

console.log('poke                    n   ' + watch.map(c => c.name.slice(0,7).padStart(8)).join(''));
for (const [label, types] of POKES) {
  const idx = types ? resolveTypes(meta, types) : [];
  // Poke and background together: the poke is an event on top of what is playing.
  const combined = [...bg, ...idx];
  const p = w.lf_alloc(combined.length * 4);
  new Uint32Array(w.memory.buffer, p, combined.length).set(combined);
  w.lf_reset();
  const acc = new Float32Array(watch.length);
  for (let bar = 0; bar < 6; bar++) {
    w.lf_simulate(400, bar >= 2 ? p : pBg, bar >= 2 ? combined.length : bg.length,
                  bar >= 2 ? 200 : 150, 0.35, watch.length, 60000);
    const r = new Float32Array(w.memory.buffer, w.lf_rates_ptr(), watch.length);
    if (bar >= 2) for (let i = 0; i < acc.length; i++) acc[i] += r[i] / 4;
  }
  const cells = watch.map((c,i) => (c.neurons.length ? acc[i]/c.neurons.length : 0).toFixed(0).padStart(8)).join('');
  console.log(`${label.padEnd(22)}${String(idx.length).padStart(5)}${cells}`);
}
console.log('\n(per-neuron Hz; MN9prob = proboscis extension, the feeding readout)');
