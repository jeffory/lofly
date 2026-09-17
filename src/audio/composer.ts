/**
 * Turns spike trains into a playable bar of music.
 *
 * The problem this solves: the song circuit fires far faster than music wants
 * notes. vPR9 alone runs ~200 Hz per neuron, which over one bar of brain time
 * is hundreds of spikes — as notes, that is white noise.
 *
 * So the bar is divided into a grid, spikes are histogrammed into cells, and
 * only the busiest K cells become notes. K is a musical density knob per voice;
 * WHICH cells win, and which pitch each carries, is decided entirely by the
 * connectome. The brain writes the rhythm and the melody, the grid and K keep
 * it listenable.
 */

export type Scale = { name: string; root: number; degrees: number[] };

/** Semitone offsets from the key root, per bar of the progression. */
export type Chord = { name: string; root: number; tones: number[] };

import { VOICE_CHANNELS, type Kit, type VoiceRole, type VoiceSpec } from './kits.ts';
export type { VoiceRole, VoiceSpec };

export type Note = {
  role: VoiceRole;
  /** Seconds from the start of the bar. */
  at: number;
  midi: number;
  velocity: number;
  duration: number;
};

const MAJ = [0, 4, 7], MIN = [0, 3, 7];

/** Key plus progression. Every chord is diatomic to its scale, so any note the
 *  brain picks lands consonant; the choice is purely one of mood. */
export type Mood = { key: string; scale: Scale; progression: Chord[] };

export const MOODS: Mood[] = [
  // These must be genuinely different pitch collections, not relative modes of
  // one. A minor, C major and D dorian are the same seven white notes viewed
  // from three tonics; with no cadence to establish a tonic, swapping between
  // them changes the chord order and almost nothing an ear can catch. Each
  // entry below differs from the others in actual pitch content — accidentals,
  // or a characteristic degree like the phrygian b2 or the lydian #4.
  {
    key: 'A minor',
    scale: { name: 'A minor', root: 57, degrees: [0, 2, 3, 5, 7, 8, 10] },
    progression: [
      { name: 'Am', root: 0, tones: MIN }, { name: 'F', root: 8, tones: MAJ },
      { name: 'C', root: 3, tones: MAJ }, { name: 'G', root: 10, tones: MAJ },
      { name: 'Am', root: 0, tones: MIN }, { name: 'Dm', root: 5, tones: MIN },
      { name: 'Em', root: 7, tones: MIN }, { name: 'G', root: 10, tones: MAJ },
    ],
  },
  {
    // b2 against the tonic; the most recognisable mode here.
    key: 'D phrygian',
    scale: { name: 'D phrygian', root: 62, degrees: [0, 1, 3, 5, 7, 8, 10] },
    progression: [
      { name: 'Dm', root: 0, tones: MIN }, { name: 'E\u266d', root: 1, tones: MAJ },
      { name: 'Dm', root: 0, tones: MIN }, { name: 'Cm', root: 10, tones: MIN },
      { name: 'Dm', root: 0, tones: MIN }, { name: 'B\u266d', root: 8, tones: MAJ },
      { name: 'E\u266d', root: 1, tones: MAJ }, { name: 'Gm', root: 5, tones: MIN },
    ],
  },
  {
    key: 'F\u266f minor',
    scale: { name: 'F\u266f minor', root: 54, degrees: [0, 2, 3, 5, 7, 8, 10] },
    progression: [
      { name: 'F\u266fm', root: 0, tones: MIN }, { name: 'D', root: 8, tones: MAJ },
      { name: 'A', root: 3, tones: MAJ }, { name: 'E', root: 10, tones: MAJ },
      { name: 'F\u266fm', root: 0, tones: MIN }, { name: 'Bm', root: 5, tones: MIN },
      { name: 'C\u266fm', root: 7, tones: MIN }, { name: 'E', root: 10, tones: MAJ },
    ],
  },
  {
    key: 'E\u266d major',
    scale: { name: 'E\u266d major', root: 63, degrees: [0, 2, 4, 5, 7, 9, 11] },
    progression: [
      { name: 'E\u266d', root: 0, tones: MAJ }, { name: 'B\u266d', root: 7, tones: MAJ },
      { name: 'Cm', root: 9, tones: MIN }, { name: 'A\u266d', root: 5, tones: MAJ },
      { name: 'E\u266d', root: 0, tones: MAJ }, { name: 'Gm', root: 4, tones: MIN },
      { name: 'Fm', root: 2, tones: MIN }, { name: 'B\u266d', root: 7, tones: MAJ },
    ],
  },
  {
    // #4 gives the floating, unresolved brightness.
    key: 'G lydian',
    scale: { name: 'G lydian', root: 55, degrees: [0, 2, 4, 6, 7, 9, 11] },
    progression: [
      { name: 'G', root: 0, tones: MAJ }, { name: 'A', root: 2, tones: MAJ },
      { name: 'G', root: 0, tones: MAJ }, { name: 'D', root: 7, tones: MAJ },
      { name: 'Em', root: 9, tones: MIN }, { name: 'A', root: 2, tones: MAJ },
      { name: 'F\u266fm', root: 11, tones: MIN }, { name: 'D', root: 7, tones: MAJ },
    ],
  },
];

export const A_MINOR = MOODS[0].scale;
export const PROGRESSION = MOODS[0].progression;

/**
 * Map a position in [0, 1) onto a pitch from the current chord or scale.
 *
 * Pitch classes are resolved against the KEY root, not against the voice's own
 * `low` note, and the scale is NOT transposed by the chord root. Getting either
 * wrong is audible: transposing the scale with the chord plays the parallel
 * minor over every major chord (Ab against A on the F), and deriving classes
 * from `low` puts each voice in its own key (the pluck, low = E4, played Em
 * over Am). `low` and `span` are only a register window.
 */
function quantizePitch(spec: VoiceSpec, chord: Chord, scale: Scale, position: number): number {
  const classes = new Set(
    (spec.chordal ? chord.tones.map(t => t + chord.root) : scale.degrees)
      .map(s => ((s % 12) + 12) % 12),
  );
  const ladder: number[] = [];
  for (let midi = spec.low; midi <= spec.low + spec.span; midi++) {
    if (classes.has((((midi - scale.root) % 12) + 12) % 12)) ladder.push(midi);
  }
  if (!ladder.length) return spec.low;
  return ladder[Math.min(ladder.length - 1, Math.floor(position * ladder.length))];
}

export type ComposeInput = {
  /** Instrument kit: sets each voice's register, density, grid and sound. */
  kit: Kit;
  /** Spike events for this bar, grouped by channel name. */
  byChannel: Map<string, { slot: number; at: number }[]>;
  /** Neurons per channel, used to turn a slot into a pitch position. */
  channelSize: Map<string, number>;
  /** Brain-time milliseconds this bar covers. */
  brainMs: number;
  barSeconds: number;
  bar: number;
  scale?: Scale;
  progression?: Chord[];
  /** Global density scaler, 0–2. */
  intensity?: number;
};

export function composeBar(input: ComposeInput): Note[] {
  const scale = input.scale ?? A_MINOR;
  const progression = input.progression ?? PROGRESSION;
  const chord = progression[input.bar % progression.length];
  const intensity = input.intensity ?? 1;
  const notes: Note[] = [];

  for (const spec of input.kit.voices) {
    const events = input.byChannel.get(VOICE_CHANNELS[spec.role]);
    if (!events || !events.length) continue;
    const size = Math.max(1, input.channelSize.get(VOICE_CHANNELS[spec.role]) ?? 1);

    // Histogram spikes into grid cells, tracking the dominant neuron per cell.
    const counts = new Float32Array(spec.division);
    const slotSum = new Float32Array(spec.division);
    for (const e of events) {
      const cell = Math.min(spec.division - 1, Math.floor((e.at / input.brainMs) * spec.division));
      counts[cell]++;
      slotSum[cell] += e.slot;
    }

    // Keep only the busiest cells: the brain chooses the rhythm, K sets density.
    const budget = Math.max(1, Math.round(spec.density * intensity));
    const ranked = Array.from(counts.keys())
      .filter(c => counts[c] > 0)
      .sort((a, b) => counts[b] - counts[a] || a - b)
      .slice(0, budget)
      .sort((a, b) => a - b);
    if (!ranked.length) continue;

    const loudest = Math.max(...ranked.map(c => counts[c]));
    const cellSeconds = input.barSeconds / spec.division;
    for (const cell of ranked) {
      const position = (slotSum[cell] / counts[cell]) / size;
      const velocity = 0.35 + 0.65 * (counts[cell] / loudest);
      notes.push({
        role: spec.role,
        at: cell * cellSeconds,
        midi: spec.span > 0 ? quantizePitch(spec, chord, scale, position) : 0,
        velocity: Math.min(1, velocity) * spec.gain,
        duration: cellSeconds * spec.hold,
      });
    }
  }
  return notes.sort((a, b) => a.at - b.at);
}

export const chordName = (bar: number, progression: Chord[] = PROGRESSION) =>
  progression[bar % progression.length].name;
