/**
 * A small Web Audio instrument rack, driven entirely by kit data.
 *
 * No dependencies: the template ships React, Three and nothing else, and every
 * voice here is a couple of oscillators into a VCA. Everything is scheduled
 * against AudioContext.currentTime, so notes land sample-accurately even while
 * the simulation worker is busy.
 */
import type { FxSpec, Kit, Patch } from './kits';
import { voiceOf } from './kits';
import type { Note } from './composer';

const midiToHz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const safe = (x: number) => Math.max(0.0001, x);

export class AudioEngine {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly dry: GainNode;
  private readonly delaySend: GainNode;
  private readonly reverbSend: GainNode;
  private readonly delayNode: DelayNode;
  private readonly feedback: GainNode;
  private readonly damp: BiquadFilterNode;
  private readonly convolver: ConvolverNode;
  private noise: AudioBuffer | null = null;
  private fx: FxSpec | null = null;

  constructor() {
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = 0.55;

    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;
    this.master.connect(compressor).connect(this.context.destination);

    this.dry = this.context.createGain();
    this.dry.connect(this.master);

    this.delaySend = this.context.createGain();
    this.delayNode = this.context.createDelay(2);
    this.feedback = this.context.createGain();
    this.damp = this.context.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.delaySend.connect(this.delayNode).connect(this.damp).connect(this.feedback).connect(this.delayNode);
    this.damp.connect(this.master);

    this.reverbSend = this.context.createGain();
    this.convolver = this.context.createConvolver();
    this.reverbSend.connect(this.convolver).connect(this.master);
  }

  resume() { return this.context.resume(); }
  get currentTime() { return this.context.currentTime; }

  setVolume(value: number) {
    this.master.gain.setTargetAtTime(value, this.context.currentTime, 0.05);
  }

  /** Retune the shared effects. Cheap enough to call on every kit change. */
  applyFx(fx: FxSpec) {
    if (this.fx && this.fx.reverbSeconds === fx.reverbSeconds && this.fx.reverbDecay === fx.reverbDecay) {
      // Reuse the impulse; only the cheap parameters changed.
    } else {
      this.convolver.buffer = this.impulse(fx.reverbSeconds, fx.reverbDecay);
    }
    const now = this.context.currentTime;
    this.delayNode.delayTime.setTargetAtTime(fx.delayTime, now, 0.05);
    this.feedback.gain.setTargetAtTime(fx.delayFeedback, now, 0.05);
    this.damp.frequency.setTargetAtTime(fx.delayDamp, now, 0.05);
    this.reverbSend.gain.value = fx.reverbMix;
    this.master.gain.setTargetAtTime(fx.master, now, 0.08);
    this.fx = fx;
  }

  /** Exponentially decaying noise, which is a serviceable room tail. */
  private impulse(seconds: number, decay: number) {
    const rate = this.context.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = this.context.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++)
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
    return buffer;
  }

  private noiseBuffer() {
    if (!this.noise) {
      const rate = this.context.sampleRate;
      this.noise = this.context.createBuffer(1, rate, rate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  private send(source: AudioNode, sends: [number, number, number]) {
    const mix = (target: GainNode, amount: number) => {
      if (amount <= 0) return;
      const gain = this.context.createGain();
      gain.gain.value = amount;
      source.connect(gain).connect(target);
    };
    mix(this.dry, sends[0]);
    mix(this.delaySend, sends[1]);
    mix(this.reverbSend, sends[2]);
  }

  play(note: Note, at: number, kit: Kit) {
    const patch = voiceOf(kit, note.role).patch;
    const ctx = this.context;
    const v = note.velocity;

    if (patch.kind === 'kick') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(patch.from, at);
      osc.frequency.exponentialRampToValueAtTime(patch.to, at + patch.decay * 0.5);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(safe(v), at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + patch.decay);
      osc.connect(gain);
      this.send(gain, patch.sends);
      osc.start(at); osc.stop(at + patch.decay + 0.02);
      return;
    }

    if (patch.kind === 'noise') {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer();
      source.playbackRate.value = patch.rate;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = patch.highpass;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(safe(v * 0.55), at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + patch.decay);
      source.connect(hp).connect(gain);
      this.send(gain, patch.sends);
      source.start(at); source.stop(at + patch.decay + 0.02);
      return;
    }

    this.playTonal(note, at, patch, v);
  }

  private playTonal(note: Note, at: number, patch: Extract<Patch, { kind: 'tonal' }>, v: number) {
    const ctx = this.context;
    const base = midiToHz(note.midi);
    const [attack, decay, sustain, release] = patch.env;
    const hold = Math.max(note.duration, attack + decay);

    for (const layer of patch.layers) {
      const osc = ctx.createOscillator();
      osc.type = layer.type;
      osc.frequency.setValueAtTime(base * Math.pow(2, layer.octave), at);
      osc.detune.value = layer.detune;

      const gain = ctx.createGain();
      const g = gain.gain;
      const peak = safe(v * layer.gain);
      g.setValueAtTime(0.0001, at);
      g.exponentialRampToValueAtTime(peak, at + attack);
      g.exponentialRampToValueAtTime(safe(peak * sustain), at + attack + decay);
      g.setValueAtTime(safe(peak * sustain), at + hold);
      g.exponentialRampToValueAtTime(0.0001, at + hold + release);

      let tail: AudioNode = gain;
      if (patch.filter) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        const cutoff = Math.min(18000, base * patch.filter);
        lp.frequency.setValueAtTime(cutoff, at);
        lp.frequency.exponentialRampToValueAtTime(
          Math.max(180, cutoff * patch.sweep), at + hold + release);
        lp.Q.value = patch.q;
        gain.connect(lp);
        tail = lp;
      }
      osc.connect(gain);
      this.send(tail, patch.sends);
      osc.start(at);
      osc.stop(at + hold + release + 0.02);
    }
  }

  close() { void this.context.close(); }
}
