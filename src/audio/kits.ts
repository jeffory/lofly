/**
 * Instrument kits: the synth patch for each voice plus how it plays.
 *
 * A style is not just a timbre. A bell that fires sixteen times a bar sounds
 * like a broken clock, and a kick that only lands twice sounds like a mistake,
 * so a kit sets register, density and grid alongside the sound itself.
 *
 * What a kit deliberately cannot change is which neurons feed which voice.
 * That mapping is measured, not decorative — pIP10 drives the lead because it
 * is the song command neuron, the power muscles drive the hats because they are
 * the only population that fires in nearly every grid cell. Kits vary the
 * performance; the performer stays the same.
 */

export type VoiceRole = 'bass' | 'keys' | 'lead' | 'pluck' | 'perc' | 'hat';

/** Fixed, biologically motivated: which simulation channel plays which part. */
export const VOICE_CHANNELS: Record<VoiceRole, string> = {
  bass: 'pulse',        // dPR1 + dMS9, the pulse-song interneurons
  keys: 'TN1a',         // thoracic song, 22 cells, sustained
  lead: 'pIP10',        // the descending song command neuron
  pluck: 'steer-fine',  // hg1 / tp1 / tp2 wing steering muscles
  perc: 'steer-basal',  // b1 / b2 / b3 / i1 basalar muscles
  hat: 'power',         // DLMn / DVMn, the wingbeat itself
};

export type Layer = {
  type: OscillatorType;
  /** Cents. Two detuned layers give chorus without an effect. */
  detune: number;
  /** Octave offset from the written note. */
  octave: number;
  gain: number;
};

export type Patch =
  | {
      kind: 'tonal';
      layers: Layer[];
      /** Attack, decay, sustain (0-1), release — seconds except sustain. */
      env: [number, number, number, number];
      /** Lowpass cutoff as a multiple of the note frequency; null for none. */
      filter: number | null;
      /** Resonance, and how far the cutoff falls over the note. */
      q: number;
      sweep: number;
      /** dry, delay, reverb. */
      sends: [number, number, number];
    }
  | { kind: 'kick'; from: number; to: number; decay: number; sends: [number, number, number] }
  | { kind: 'noise'; highpass: number; rate: number; decay: number; sends: [number, number, number] };

export type VoiceSpec = {
  role: VoiceRole;
  /** Grid cells per bar this voice can land on. */
  division: number;
  /** Maximum notes per bar; the brain picks which cells, this caps how many. */
  density: number;
  low: number;
  span: number;
  chordal: boolean;
  gain: number;
  /** Note length as a fraction of a grid cell. */
  hold: number;
  patch: Patch;
};

export type FxSpec = {
  reverbSeconds: number;
  reverbDecay: number;
  reverbMix: number;
  delayTime: number;
  delayFeedback: number;
  delayDamp: number;
  master: number;
};

export type Kit = { name: string; blurb: string; fx: FxSpec; voices: VoiceSpec[] };

const v = (
  role: VoiceRole, division: number, density: number, low: number, span: number,
  chordal: boolean, gain: number, hold: number, patch: Patch,
): VoiceSpec => ({ role, division, density, low, span, chordal, gain, hold, patch });

export const KITS: Kit[] = [
  {
    name: 'Lo-fi',
    blurb: 'Soft, filtered, a little dusty. Slow attacks and a short room.',
    fx: { reverbSeconds: 1.5, reverbDecay: 3.2, reverbMix: 1, delayTime: 0.32,
          delayFeedback: 0.34, delayDamp: 2200, master: 0.55 },
    voices: [
      v('bass',  8, 4, 33, 12, true,  0.9,  1.8, { kind: 'tonal', layers: [{ type: 'sawtooth', detune: 0, octave: 0, gain: 0.7 }, { type: 'sine', detune: 0, octave: -1, gain: 0.9 }], env: [0.012, 0.10, 0.62, 0.18], filter: 5, q: 4, sweep: 0.35, sends: [1, 0, 0.06] }),
      v('keys',  8, 5, 57, 14, true,  0.45, 1.8, { kind: 'tonal', layers: [{ type: 'triangle', detune: -7, octave: 0, gain: 0.5 }, { type: 'triangle', detune: 7, octave: 0, gain: 0.5 }], env: [0.035, 0.28, 0.42, 0.55], filter: 5, q: 3, sweep: 0.4, sends: [0.7, 0.25, 0.45] }),
      v('lead', 16, 7, 69, 19, false, 0.55, 0.9, { kind: 'tonal', layers: [{ type: 'triangle', detune: 0, octave: 0, gain: 0.8 }, { type: 'sine', detune: 4, octave: 0, gain: 0.3 }], env: [0.02, 0.16, 0.34, 0.35], filter: 4, q: 5, sweep: 0.35, sends: [0.8, 0.4, 0.35] }),
      v('pluck',16, 8, 64, 17, true,  0.38, 0.8, { kind: 'tonal', layers: [{ type: 'sawtooth', detune: 5, octave: 0, gain: 0.6 }], env: [0.005, 0.12, 0.08, 0.16], filter: 6, q: 6, sweep: 0.3, sends: [0.75, 0.45, 0.35] }),
      v('perc', 16, 6, 0, 0, false, 0.8,  0.5, { kind: 'kick', from: 165, to: 46, decay: 0.24, sends: [1, 0, 0.06] }),
      v('hat',  16, 10, 0, 0, false, 0.28, 0.5, { kind: 'noise', highpass: 6400, rate: 1.4, decay: 0.055, sends: [0.9, 0.22, 0.18] }),
    ],
  },
  {
    name: 'Glass',
    blurb: 'Sparse bells in a large room. Long tails, nothing hurried.',
    fx: { reverbSeconds: 3.4, reverbDecay: 2.0, reverbMix: 1, delayTime: 0.45,
          delayFeedback: 0.42, delayDamp: 5200, master: 0.5 },
    voices: [
      v('bass',  8, 3, 33, 12, true,  0.75, 2.6, { kind: 'tonal', layers: [{ type: 'sine', detune: 0, octave: 0, gain: 1 }], env: [0.05, 0.5, 0.5, 0.8], filter: null, q: 1, sweep: 1, sends: [0.85, 0.1, 0.5] }),
      v('keys',  8, 4, 64, 16, true,  0.4,  2.4, { kind: 'tonal', layers: [{ type: 'sine', detune: 0, octave: 0, gain: 0.6 }, { type: 'sine', detune: 0, octave: 1, gain: 0.25 }], env: [0.01, 0.9, 0.15, 1.4], filter: null, q: 1, sweep: 1, sends: [0.5, 0.3, 0.9] }),
      v('lead', 16, 4, 76, 19, false, 0.5,  1.6, { kind: 'tonal', layers: [{ type: 'sine', detune: 0, octave: 0, gain: 0.7 }, { type: 'sine', detune: 3, octave: 2, gain: 0.12 }], env: [0.006, 0.8, 0.1, 1.2], filter: null, q: 1, sweep: 1, sends: [0.6, 0.45, 0.8] }),
      v('pluck',16, 5, 72, 17, true,  0.3,  1.2, { kind: 'tonal', layers: [{ type: 'triangle', detune: 0, octave: 1, gain: 0.5 }], env: [0.004, 0.45, 0.05, 0.7], filter: null, q: 1, sweep: 1, sends: [0.5, 0.5, 0.8] }),
      v('perc', 16, 3, 0, 0, false, 0.5,  0.5, { kind: 'kick', from: 120, to: 55, decay: 0.5, sends: [0.7, 0.15, 0.6] }),
      v('hat',  16, 5, 0, 0, false, 0.18, 0.5, { kind: 'noise', highpass: 9000, rate: 2.2, decay: 0.09, sends: [0.6, 0.4, 0.7] }),
    ],
  },
  {
    name: 'Neon',
    blurb: 'Bright saws, tight envelopes, busier hands.',
    fx: { reverbSeconds: 1.1, reverbDecay: 4.0, reverbMix: 1, delayTime: 0.24,
          delayFeedback: 0.3, delayDamp: 3400, master: 0.5 },
    voices: [
      v('bass',  8, 6, 33, 12, true,  0.95, 0.9, { kind: 'tonal', layers: [{ type: 'sawtooth', detune: -6, octave: 0, gain: 0.55 }, { type: 'sawtooth', detune: 6, octave: 0, gain: 0.55 }], env: [0.004, 0.09, 0.5, 0.1], filter: 4, q: 8, sweep: 0.25, sends: [1, 0.05, 0.05] }),
      v('keys',  8, 6, 57, 16, true,  0.4,  1.2, { kind: 'tonal', layers: [{ type: 'sawtooth', detune: -9, octave: 0, gain: 0.4 }, { type: 'sawtooth', detune: 9, octave: 0, gain: 0.4 }], env: [0.01, 0.2, 0.4, 0.28], filter: 6, q: 6, sweep: 0.3, sends: [0.7, 0.35, 0.3] }),
      v('lead', 16, 9, 69, 19, false, 0.55, 0.7, { kind: 'tonal', layers: [{ type: 'square', detune: 0, octave: 0, gain: 0.6 }, { type: 'sawtooth', detune: 8, octave: 0, gain: 0.3 }], env: [0.004, 0.11, 0.3, 0.16], filter: 5, q: 9, sweep: 0.28, sends: [0.85, 0.45, 0.2] }),
      v('pluck',16, 11, 64, 17, true,  0.34, 0.5, { kind: 'tonal', layers: [{ type: 'sawtooth', detune: 0, octave: 1, gain: 0.5 }], env: [0.002, 0.07, 0.04, 0.09], filter: 8, q: 10, sweep: 0.2, sends: [0.8, 0.5, 0.2] }),
      v('perc', 16, 8, 0, 0, false, 0.9,  0.5, { kind: 'kick', from: 210, to: 42, decay: 0.16, sends: [1, 0, 0.03] }),
      v('hat',  16, 13, 0, 0, false, 0.3,  0.5, { kind: 'noise', highpass: 8200, rate: 1.9, decay: 0.035, sends: [0.95, 0.15, 0.1] }),
    ],
  },
];

export const voiceOf = (kit: Kit, role: VoiceRole) =>
  kit.voices.find(x => x.role === role) ?? kit.voices[0];
