/** Do small, specific cell types keep their structure under burst drive? */
import { readFileSync } from 'node:fs';
import { BrainEngine } from '../src/sim/engine.ts';
import type { ConnectomeMeta } from '../src/sim/types.ts';
import { resolveTypes } from '../src/sim/circuits.ts';

const dir = new URL('../public/data/connectome/', import.meta.url);
const bin = (n: string) => { const b = readFileSync(new URL(n, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8')) as ConnectomeMeta;
const engine = new BrainEngine({ meta,
  indptr: new Uint32Array(bin('indptr.bin')), indices: new Uint32Array(bin('indices.bin')),
  weights: new Int16Array(bin('weights.bin')), viewerMap: new Int32Array(bin('viewer_map.bin')) });

const CAND = ['pIP10', 'dPR1', 'pMP2', 'dMS9', 'TN1a', 'b1 MN', 'b2 MN', 'b3 MN',
              'hg1 MN', 'hg2 MN', 'hg3 MN', 'i1 MN', 'i2 MN', 'iii1 MN', 'ps1 MN',
              'tp1 MN', 'tp2 MN', 'DLMn', 'DVMn', 'vPR9', 'vMS12', 'dMS2'];
const channels = CAND.map(n => ({ name: n, neurons: resolveTypes(meta, [n]) }));
const BRAIN_MS = 140, CELLS = 16, DUTY = 0.35;

engine.reset();
const stats = new Map<string, { cv: number[]; hits: number[] }>();
CAND.forEach(n => stats.set(n, { cv: [], hits: [] }));

for (let bar = 0; bar < 8; bar++) {
  // Burst: drive pIP10 for the first 35% of the bar, then let the circuit ring out.
  const on = engine.simulate({ durationMs: BRAIN_MS * DUTY,
    stimulus: [{ neurons: resolveTypes(meta, ['pIP10']), rateHz: 150 }], channels, maxEvents: 60000 });
  const off = engine.simulate({ durationMs: BRAIN_MS * (1 - DUTY),
    stimulus: [], channels, maxEvents: 60000 });

  channels.forEach((ch, ci) => {
    const hist = new Array(CELLS).fill(0);
    for (const e of on.events) if (e.channel === ci) hist[Math.min(CELLS - 1, Math.floor((e.at / BRAIN_MS) * CELLS))]++;
    for (const e of off.events) if (e.channel === ci) hist[Math.min(CELLS - 1, Math.floor(((BRAIN_MS * DUTY + e.at) / BRAIN_MS) * CELLS))]++;
    const total = hist.reduce((a, b) => a + b, 0);
    const m = total / CELLS;
    const sd = Math.sqrt(hist.reduce((a, b) => a + (b - m) ** 2, 0) / CELLS);
    const s = stats.get(ch.name)!;
    s.cv.push(m ? sd / m : 0);
    s.hits.push(hist.filter(h => h > 0).length);
    if (bar >= 5 && ['pIP10', 'b1 MN', 'hg1 MN', 'DLMn', 'TN1a'].includes(ch.name)) {
      const max = Math.max(1, ...hist);
      console.log(`  bar${bar} ${ch.name.padEnd(8)} |${hist.map(h => ' ▁▂▃▄▅▆▇█'[Math.round(h / max * 8)]).join('')}| n=${ch.neurons.length} total=${total}`);
    }
  });
}

console.log('\ntype       neurons  meanCV  cells-with-spikes  verdict');
for (const [name, s] of stats) {
  const cv = s.cv.reduce((a, b) => a + b, 0) / s.cv.length;
  const hits = s.hits.reduce((a, b) => a + b, 0) / s.hits.length;
  const n = channels.find(c => c.name === name)!.neurons.length;
  const verdict = hits < 0.5 ? 'silent' : cv > 0.8 ? 'RHYTHMIC' : cv > 0.45 ? 'usable' : 'drone';
  console.log(`${name.padEnd(10)} ${n.toString().padStart(6)}  ${cv.toFixed(2).padStart(6)}  ${hits.toFixed(1).padStart(16)}  ${verdict}`);
}
