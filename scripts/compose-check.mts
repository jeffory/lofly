/** Does the composer actually spread pitch and rhythm, given real spike trains? */
import { readFileSync } from 'node:fs';
import { BrainEngine } from '../src/sim/engine.ts';
import type { ConnectomeMeta } from '../src/sim/types.ts';
import { buildChannels, resolveTypes } from '../src/sim/circuits.ts';
import { composeBar, chordName, VOICES } from '../src/audio/composer.ts';

const dir = new URL('../public/data/connectome/', import.meta.url);
const bin = (n: string) => { const b = readFileSync(new URL(n, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8')) as ConnectomeMeta;
const engine = new BrainEngine({ meta,
  indptr: new Uint32Array(bin('indptr.bin')), indices: new Uint32Array(bin('indices.bin')),
  weights: new Int16Array(bin('weights.bin')), viewerMap: new Int32Array(bin('viewer_map.bin')) });

const channels = buildChannels(meta);
const sizes = new Map(channels.map(c => [c.name, c.neurons.length]));
console.log('channels:', channels.map(c => `${c.name}=${c.neurons.length}`).join(' '));

const BRAIN_MS = Number(process.argv[2] ?? 140), BAR_SECONDS = 2.5;
const byRole = new Map<string, number[]>();
const NOTE = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

for (let bar = 0; bar < 8; bar++) {
  const r = engine.simulate({ durationMs: BRAIN_MS, dutyCycle: 0.35,
    stimulus: [{ neurons: resolveTypes(meta, ['pIP10']), rateHz: 150 }],
    channels, maxEvents: 40000 });
  const byChannel = new Map<string, { slot: number; at: number }[]>();
  for (const e of r.events) {
    const name = channels[e.channel]?.name; if (!name) continue;
    (byChannel.get(name) ?? byChannel.set(name, []).get(name)!).push(e);
  }
  const notes = composeBar({ byChannel, channelSize: sizes, brainMs: r.brainMs, barSeconds: BAR_SECONDS, bar, intensity: 1 });
  for (const n of notes) (byRole.get(n.role) ?? byRole.set(n.role, []).get(n.role)!).push(n.midi);

  const grid = (role: string) => {
    const cells = new Array(16).fill('·');
    for (const n of notes.filter(x => x.role === role))
      cells[Math.min(15, Math.round((n.at / BAR_SECONDS) * 16))] = role === 'perc' || role === 'hat' ? 'x' : NOTE[n.midi % 12][0].toLowerCase();
    return cells.join('');
  };
  console.log(`bar${bar} ${chordName(bar).padEnd(3)} lead|${grid('lead')}| bass|${grid('bass')}| keys|${grid('keys')}| pluck|${grid('pluck')}| perc|${grid('perc')}| hat|${grid('hat')}|  (${notes.length} notes)`);
}

console.log('\nrole    notes  distinct pitches  range');
for (const spec of VOICES) {
  const m = byRole.get(spec.role) ?? [];
  const uniq = [...new Set(m)].sort((a, b) => a - b);
  const label = spec.span > 0 ? `${uniq.length} (${uniq.join(',')})` : 'unpitched';
  console.log(`${spec.role.padEnd(7)} ${m.length.toString().padStart(5)}  ${label}`);
}
