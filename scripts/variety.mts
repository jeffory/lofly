/** How similar is each bar to the last, and which knob actually changes that? */
import { readFileSync } from 'node:fs';
import { BrainEngine } from '../src/sim/engine.ts';
import type { ConnectomeMeta } from '../src/sim/types.ts';
import { buildChannels, resolveTypes, STIMULI } from '../src/sim/circuits.ts';
import { composeBar, MOODS, VOICES } from '../src/audio/composer.ts';

const dir = new URL('../public/data/connectome/', import.meta.url);
const bin = (n: string) => { const b = readFileSync(new URL(n, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8')) as ConnectomeMeta;
const data = { meta, indptr: new Uint32Array(bin('indptr.bin')), indices: new Uint32Array(bin('indices.bin')),
               weights: new Int16Array(bin('weights.bin')), viewerMap: new Int32Array(bin('viewer_map.bin')) };
const channels = buildChannels(meta);
const sizes = new Map(channels.map(c => [c.name, c.neurons.length]));
const mood = MOODS[0];
const BAR = 2.5, BRAIN = 400;
const seeded = (s: number) => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

type Bar = { onsets: Map<string, Set<number>>; pitches: Map<string, Set<number>>; notes: number };

function runBars(label: string, plan: (bar: number) => { stim: string; rateHz: number; duty: number; reset?: boolean }, bars = 16): Bar[] {
  const engine = new BrainEngine(data);
  engine.setRandom(seeded(7));
  const out: Bar[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const p = plan(bar);
    if (p.reset) engine.reset();
    const spec = STIMULI.find(s => s.key === p.stim)!;
    const r = engine.simulate({ durationMs: BRAIN, dutyCycle: p.duty,
      stimulus: [{ neurons: resolveTypes(meta, spec.types), rateHz: p.rateHz }],
      channels, maxEvents: 60000 });
    const byChannel = new Map<string, { slot: number; at: number }[]>();
    for (const e of r.events) {
      const n = channels[e.channel]?.name; if (!n) continue;
      const l = byChannel.get(n); if (l) l.push(e); else byChannel.set(n, [e]);
    }
    const notes = composeBar({ byChannel, channelSize: sizes, brainMs: r.brainMs,
      barSeconds: BAR, bar, intensity: 1, scale: mood.scale, progression: mood.progression });
    const onsets = new Map<string, Set<number>>(), pitches = new Map<string, Set<number>>();
    for (const v of VOICES) { onsets.set(v.role, new Set()); pitches.set(v.role, new Set()); }
    for (const n of notes) {
      onsets.get(n.role)!.add(Math.round((n.at / BAR) * 16));
      if (n.midi) pitches.get(n.role)!.add(n.midi);
    }
    out.push({ onsets, pitches, notes: notes.length });
  }
  return out;
}

/** Mean Jaccard overlap between bars 4 apart (same chord), across voices. */
function repetition(bars: Bar[]) {
  const jac = (a: Set<number>, b: Set<number>) => {
    if (!a.size && !b.size) return 1;
    let inter = 0; for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };
  let rhythm = 0, pitch = 0, n = 0;
  for (let i = 4; i < bars.length; i++)
    for (const v of VOICES) {
      rhythm += jac(bars[i].onsets.get(v.role)!, bars[i - 4].onsets.get(v.role)!);
      if (v.span > 0) { pitch += jac(bars[i].pitches.get(v.role)!, bars[i - 4].pitches.get(v.role)!); }
      n++;
    }
  const pv = VOICES.filter(v => v.span > 0).length;
  return { rhythm: rhythm / n, pitch: pitch / ((bars.length - 4) * pv) };
}

const CYCLE = ['pIP10', 'JO', 'pC1', 'DNa'];
const plans: [string, (b: number) => { stim: string; rateHz: number; duty: number; reset?: boolean }][] = [
  ['baseline (constant pIP10 150Hz, duty .35)', () => ({ stim: 'pIP10', rateHz: 150, duty: 0.35 })],
  ['cycle stimulus every 4 bars',               b => ({ stim: CYCLE[Math.floor(b / 4) % 4], rateHz: 150, duty: 0.35 })],
  ['cycle stimulus every bar',                  b => ({ stim: CYCLE[b % 4], rateHz: 150, duty: 0.35 })],
  ['vary drive rate 60/100/150/220',            b => ({ stim: 'pIP10', rateHz: [60, 100, 150, 220][b % 4], duty: 0.35 })],
  ['vary burst length .15/.35/.6/.9',           b => ({ stim: 'pIP10', rateHz: 150, duty: [0.15, 0.35, 0.6, 0.9][b % 4] })],
  ['reset the network every 4 bars',            b => ({ stim: 'pIP10', rateHz: 150, duty: 0.35, reset: b % 4 === 0 })],
  ['all four combined',                         b => ({ stim: CYCLE[Math.floor(b / 4) % 4], rateHz: [150, 90, 200, 120][b % 4],
                                                        duty: [0.3, 0.5, 0.2, 0.7][b % 4], reset: b % 8 === 0 })],
];

console.log('lower = more varied.  1.00 = every 4th bar identical\n');
console.log('plan                                        rhythm  pitch   notes/bar');
for (const [label, plan] of plans) {
  const bars = runBars(label, plan);
  const r = repetition(bars);
  const avg = bars.reduce((a, b) => a + b.notes, 0) / bars.length;
  console.log(`${label.padEnd(43)} ${r.rhythm.toFixed(2)}    ${r.pitch.toFixed(2)}    ${avg.toFixed(0)}`);
}
