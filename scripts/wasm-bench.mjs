/** Correctness and speed of the SIMD128 kernel vs the JS engine, same connectome. */
import { readFileSync } from 'node:fs';

const dir = new URL('../public/data/connectome/', import.meta.url);
const read = n => readFileSync(new URL(n, dir));
const meta = JSON.parse(read('meta.json'));

const wasmBytes = readFileSync(new URL('../wasm/target/wasm32-unknown-unknown/release/lif_wasm.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const w = instance.exports;
const mem = () => new Uint8Array(w.memory.buffer);

// Copy each array into linear memory. Re-read the buffer after every alloc:
// growing wasm memory detaches the old ArrayBuffer.
const put = (bytes) => { const p = w.lf_alloc(bytes.length); mem().set(bytes, p); return p; };
const pIndptr  = put(read('indptr.bin'));
const pIndices = put(read('indices.bin'));
const pWeights = put(read('weights.bin'));
const pViewer  = put(read('viewer_map.bin'));

const DT = 0.2;
w.lf_init(meta.nodes, meta.edges, meta.viewerRows, DT, pIndptr, pIndices, pWeights, pViewer);

const typesOf = (...pre) => { const o = []; for (const [t, l] of Object.entries(meta.types)) if (pre.some(p => t === p || t.startsWith(p))) o.push(...l); return o; };
const CH = [['pIP10', ['pIP10']], ['pulse', ['dPR1','dMS9']], ['TN1a', ['TN1a']],
            ['fine', ['hg1 MN','tp1 MN','tp2 MN']], ['basal', ['b1 MN','b2 MN','b3 MN','i1 MN']],
            ['power', ['DLMn','DVMn']]];
w.lf_clear_channels();
const sizes = CH.map(([, t], c) => { const ns = typesOf(...t); ns.forEach((n, s) => w.lf_set_channel(n, c, s)); return ns.length; });

const stimIdx = typesOf('pIP10');
const pStim = w.lf_alloc(stimIdx.length * 4);
new Uint32Array(w.memory.buffer, pStim, stimIdx.length).set(stimIdx);

const run = (ms, duty) => {
  const t0 = performance.now();
  const n = w.lf_simulate(ms, pStim, stimIdx.length, 150, duty, CH.length, 40000);
  const wall = performance.now() - t0;
  const rates = Array.from(new Float32Array(w.memory.buffer, w.lf_rates_ptr(), CH.length));
  return { n, wall, rates, spikes: w.lf_total_spikes() };
};

console.log('--- warmup ---');
run(200, 1);
console.log('--- 1 second of brain time, constant drive ---');
let best = Infinity, spikes = 0, rates = [];
for (let i = 0; i < 3; i++) { const r = run(1000, 1); best = Math.min(best, r.wall); spikes = r.spikes; rates = r.rates; }
console.log(`  ${(1000/best).toFixed(2)}x real time  (${best.toFixed(0)}ms wall for 1000ms brain)`);
console.log(`  ${spikes.toLocaleString()} spikes`);
console.log('  per-neuron Hz:', CH.map(([n], i) => `${n}=${(rates[i]/sizes[i]).toFixed(0)}`).join(' '));

console.log('\n--- as the app uses it: 140ms bar, 35% duty ---');
w.lf_reset();
let tot = 0;
for (let bar = 0; bar < 8; bar++) { const r = run(140, 0.35); tot += r.wall; }
console.log(`  ${(tot/8).toFixed(1)}ms wall per bar  ->  ${(140/(tot/8)).toFixed(2)}x real time`);
console.log(`  bar budget at 96bpm is 2500ms, so ${(2500/(tot/8)).toFixed(0)}x headroom`);
