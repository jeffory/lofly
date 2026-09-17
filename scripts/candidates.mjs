/** Would these circuits make good voices? Same CV/sparseness test as the originals. */
import { readFileSync } from 'node:fs';
import { resolveTypes, STIMULI, stimulusForBar } from '../src/sim/circuits.ts';

const dir = new URL('../public/data/connectome/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8'));
const wasm = readFileSync(new URL('../wasm/target/wasm32-unknown-unknown/release/lif_wasm.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const w = instance.exports;
const put = b => { const p = w.lf_alloc(b.length); new Uint8Array(w.memory.buffer).set(b, p); return p; };
const a = put(readFileSync(new URL('indptr.bin', dir))), b2 = put(readFileSync(new URL('indices.bin', dir)));
const c2 = put(readFileSync(new URL('weights.bin', dir))), d2 = put(readFileSync(new URL('viewer_map.bin', dir)));
w.lf_init(meta.nodes, meta.edges, meta.viewerRows, 0.2, a, b2, c2, d2);

const CANDIDATES = [
  ['EPG (compass ring)',      ['EPG']],
  ['PEN (bump rotation)',     ['PEN_a', 'PEN_b']],
  ['PFL3 (steering out)',     ['PFL3']],
  ['Delta7 (ring inhibition)',['Delta7']],
  ['ER (ring neurons)',       ['ER1', 'ER2', 'ER3', 'ER4', 'ER5']],
  ['MBON (valence)',          ['MBON']],
  ['Kenyon cells',            ['KC']],
  ['LC10 (courtship vision)', ['LC10']],
  ['LPLC2 (looming)',         ['LPLC2']],
  ['DNp01 Giant Fibre',       ['DNp01']],
  ['MDN (backward walk)',     ['MDN']],
  ['MN9 (proboscis)',         ['MN9']],
  ['leg MN (Ta/Fe)',          ['Ta depressor MN', 'Ta levator MN', 'Fe reductor MN']],
  ['ORN_DA1 (cVA pheromone)', ['ORN_DA1']],
];
const channels = CANDIDATES.map(([name, types]) => ({ name, neurons: resolveTypes(meta, types) }));
w.lf_clear_channels();
channels.forEach((ch, ci) => ch.neurons.forEach((n, s) => w.lf_set_channel(n, ci, s)));
const stim = new Map();
for (const s of STIMULI) { const i = resolveTypes(meta, s.types); const p = w.lf_alloc(i.length * 4);
  new Uint32Array(w.memory.buffer, p, i.length).set(i); stim.set(s.key, [p, i.length]); }

const CELLS = 16, BARS = 12;
const stats = channels.map(() => ({ hist: new Array(CELLS).fill(0), fired: new Set(), spikes: 0, cellsUsed: [] }));
w.lf_reset();
for (let bar = 0; bar < BARS; bar++) {
  const [p, len] = stim.get(stimulusForBar(bar, 3));
  const n = w.lf_simulate(400, p, len, 150, 0.35, channels.length, 60000);
  const packed = new Uint32Array(w.memory.buffer, w.lf_events_ptr(), n * 2);
  const perBar = channels.map(() => new Array(CELLS).fill(0));
  for (let i = 0; i < n; i++) {
    const c = packed[i*2] >>> 16, slot = packed[i*2] & 0xffff, at = packed[i*2+1] * 0.2;
    const cell = Math.min(CELLS-1, Math.floor((at / 400) * CELLS));
    stats[c].hist[cell]++; perBar[c][cell]++; stats[c].fired.add(slot); stats[c].spikes++;
  }
  perBar.forEach((h, c) => stats[c].cellsUsed.push(h.filter(x => x > 0).length));
}

console.log('population                  n    Hz/cell  CV    cells/16  %active  verdict');
channels.forEach((ch, c) => {
  const s = stats[c], n = ch.neurons.length;
  const m = s.hist.reduce((x,y)=>x+y,0) / CELLS;
  const sd = Math.sqrt(s.hist.reduce((x,y)=>x+(y-m)**2,0) / CELLS);
  const cv = m ? sd/m : 0;
  const cells = s.cellsUsed.reduce((x,y)=>x+y,0) / BARS;
  const active = n ? 100 * s.fired.size / n : 0;
  const hz = n ? s.spikes / n / (BARS * 0.4) : 0;
  const verdict = cells < 0.5 ? 'silent' : cv > 0.8 ? 'RHYTHMIC' : cv > 0.45 ? 'usable' : 'drone';
  console.log(`${ch.name.padEnd(26)} ${String(n).padStart(4)}  ${hz.toFixed(0).padStart(6)}  ${cv.toFixed(2)}  ${cells.toFixed(1).padStart(6)}  ${active.toFixed(0).padStart(6)}%  ${verdict}`);
});
