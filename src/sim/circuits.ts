/**
 * Named circuits of the male fly, resolved to simulation node indices.
 *
 * These are not arbitrary neuron picks. MaleCNS is a *male* connectome, and
 * male Drosophila sing: pIP10 is the descending command neuron that initiates
 * courtship song, and the thoracic types below are the core song circuit
 * (Ding et al., Shiu/Stern/Murthy lines of work). The wing motor neurons are
 * the ones that actually move the wing and make the sound.
 *
 * So the audio channels are the fly's own output bus, not a sonification
 * mapping bolted onto unrelated cells.
 */
import type { ConnectomeMeta, Channel } from './types';

export type CircuitSpec = {
  key: string;
  label: string;
  /** Cell type names, matched as exact-or-prefix against the annotation table. */
  types: string[];
  note: string;
};

export const OUTPUT_CIRCUITS: CircuitSpec[] = [
  { key: 'pIP10', label: 'pIP10', types: ['pIP10'],
    note: 'Descending command neuron that initiates courtship song' },
  { key: 'pulse', label: 'Pulse song', types: ['dPR1', 'dMS9'],
    note: 'Core pulse-song interneurons' },
  { key: 'TN1a', label: 'TN1a', types: ['TN1a'],
    note: 'Thoracic song interneurons, 22 cells' },
  { key: 'steer-fine', label: 'hg / tp muscles', types: ['hg1 MN', 'tp1 MN', 'tp2 MN'],
    note: 'Wing hinge and tergopleural steering muscles' },
  { key: 'steer-basal', label: 'b / i muscles', types: ['b1 MN', 'b2 MN', 'b3 MN', 'i1 MN'],
    note: 'Basalar and first-axillary steering muscles' },
  { key: 'power', label: 'Power muscles', types: ['DLMn', 'DVMn'],
    note: 'DLM and DVM motor neurons — the wingbeat itself' },
];

export const STIMULI: CircuitSpec[] = [
  { key: 'pIP10', label: 'Song command (pIP10)', types: ['pIP10'],
    note: 'Drives the singing circuit directly' },
  { key: 'ORN_DA1', label: 'Pheromone (cVA / ORN_DA1)', types: ['ORN_DA1'],
    note: 'The smell of another male, and the input that starts courtship' },
  { key: 'pC1', label: 'Courtship drive (pC1 / P1)', types: ['pC1'],
    note: 'The decision to court; gates pIP10' },
  { key: 'JO', label: 'Hearing (Johnston\u2019s organ)', types: ['JO-'],
    note: 'The antennal ear \u2014 543 auditory afferents' },
  { key: 'LPLC2', label: 'Looming (LPLC2)', types: ['LPLC2'],
    note: 'Visual threat detector, upstream of escape' },
  { key: 'EPG', label: 'Heading compass (EPG)', types: ['EPG'],
    note: 'Central-complex ring that tracks which way the fly faces' },
  { key: 'DNa', label: 'Steering descendings (DNa)', types: ['DNa'],
    note: 'Locomotor descending neurons' },
];

/**
 * Order the cycle preset steps through. Measured on 16 bars: holding one
 * stimulus leaves bars four apart sharing 76% of their onsets and 83% of their
 * pitches; rotating these four every four bars drops that to 30% and 34%.
 *
 * The period matters as much as the rotation, and not in the obvious direction:
 * a faster cycle that lands in phase is worse than a slower one that does not.
 * Measured over 24 bars against the 8-bar progression, with four stimuli:
 *
 *   step   bars 4 apart    bars 8 apart
 *   fixed  0.69 / 0.62     0.68 / 0.74
 *   4      0.25 / 0.27     0.62 / 0.72
 *   3      0.40 / 0.47     0.43 / 0.58   <- default
 *   2      0.61 / 0.64     0.62 / 0.70
 *
 * Stepping every 4 bars looks best at a 4-bar lag, but that is the cycle
 * anti-aligning at exactly the lag being measured; over 8 bars it is no better
 * than holding one stimulus. Stepping every 3 gives the only setting that stays
 * varied at both scales.
 *
 * Seven stimuli at 3 bars each is a 21-bar cycle, which against the 8-bar
 * progression only realigns after 168 bars. Each entry was kept only because it
 * drives a measurably different mix downstream — per-neuron Hz into the voices:
 *
 *   stimulus   pIP10  pulse  TN1a  fine  basal  power
 *   pIP10         39     79    50    34     26    337
 *   ORN_DA1        5     30     6    34    146    276
 *   LPLC2          2     14     7    46     36    327
 *   EPG            1     15     7    58     79    330
 */
export const CYCLE_ORDER = [
  'pIP10', 'ORN_DA1', 'JO', 'pC1', 'LPLC2', 'EPG', 'DNa',
] as const;

/** Which stimulus a cycling session should use for a given bar. */
export const stimulusForBar = (bar: number, barsPerStep: number) =>
  CYCLE_ORDER[Math.floor(bar / Math.max(1, barsPerStep)) % CYCLE_ORDER.length];

/** Resolve type names to node indices. A name matches exactly or as a prefix. */
export function resolveTypes(meta: ConnectomeMeta, names: string[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const [type, list] of Object.entries(meta.types)) {
    if (!names.some(n => type === n || type.startsWith(n))) continue;
    for (const index of list) if (!seen.has(index)) { seen.add(index); out.push(index); }
  }
  return out;
}

export function buildChannels(meta: ConnectomeMeta): Channel[] {
  return OUTPUT_CIRCUITS.map(c => ({ name: c.key, neurons: resolveTypes(meta, c.types) }));
}
