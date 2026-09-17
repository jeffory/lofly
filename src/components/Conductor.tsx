/**
 * Bar clock joining the simulation to the audio output.
 *
 * Brain time and musical time are deliberately decoupled. The whole-brain LIF
 * runs at roughly 0.13x real time in a worker, so one wall second buys ~130 ms
 * of brain time. Rather than fight that, each musical bar is driven by a short
 * window of brain time (default 140 ms), which leaves comfortable headroom and
 * is still thousands of spikes to compose from. Audio is always scheduled at
 * least a bar ahead, so a slow window costs nothing until it exceeds that.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../audio/engine';
import { MOODS, chordName, composeBar, type Note } from '../audio/composer';
import { KITS } from '../audio/kits';
import { MediaSessionController } from '../audio/media-session';
import { BrainClient } from '../sim/client';
import {
  CYCLE_ORDER, OUTPUT_CIRCUITS, POKES, READOUTS, STIMULI,
  buildChannels, resolveTypes, stimulusForBar,
} from '../sim/circuits';
import type { Backend, Channel, ConnectomeMeta } from '../sim/types';

export type Telemetry = {
  bar: number;
  chord: string;
  /** The circuit actually driven this bar, which the cycle preset rotates. */
  stimulus: string;
  /** Sensory event fired into this bar, if any. */
  poke: string | null;
  realtime: number;
  awake: number;
  spikes: number;
  notes: number;
  channelRates: number[];
  underruns: number;
  /** Fraction of the bar spent simulating it; above 1.0 audio cannot keep up. */
  load: number;
  /** Set when the window was cut automatically to protect the audio. */
  autoReduced: number | null;
};

const BEATS = 4;

/** How many snapshots each bar is split into for the brain view and the pilot. */
const ACTIVITY_FRAMES = 8;
/**
 * Real-time pacing runs the brain as fast as the wall clock, so the controller
 * can read it many times a second instead of once a bar. It needs a coarser
 * step to fit: at the musical 0.2 ms a bar of brain time costs slightly more
 * than a bar of wall time even with nothing else running, while 0.45 ms runs
 * about 2x real time and still divides the 1.8 ms delay into whole steps.
 */
const LIVE_DT = 0.45;
/** Above this share of the bar, live pacing is not sustainable and gives up. */
const LIVE_GIVE_UP = 0.92;

export function useConductor(baseUrl: string, onActivity: (a: Uint8Array) => void) {
  const [meta, setMeta] = useState<ConnectomeMeta | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [status, setStatus] = useState('idle');
  const [playing, setPlaying] = useState(false);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);

  const [bpm, setBpm] = useState(96);
  const [brainMsPerBar, setBrainMsPerBar] = useState(400);
  const [intensity, setIntensity] = useState(1);
  const [duty, setDuty] = useState(0.35);
  const [moodIndex, setMoodIndex] = useState(0);
  const [cycle, setCycle] = useState(true);
  const [cycleBars, setCycleBars] = useState(3);
  const [kitIndex, setKitIndex] = useState(0);
  const [livePace, setLivePace] = useState(false);
  const [liveDropped, setLiveDropped] = useState(false);
  /** Latest per-slice channel rates, released on the audio clock. */
  const motor = useRef<Float32Array>(new Float32Array(0));
  const [stimulusKey, setStimulusKey] = useState('pIP10');
  const [rateHz, setRateHz] = useState(150);

  const startRef = useRef<(() => Promise<void>) | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const client = useRef<BrainClient | null>(null);
  const audio = useRef<AudioEngine | null>(null);
  const media = useRef<MediaSessionController | null>(null);
  const channels = useRef<Channel[]>([]);
  const running = useRef(false);
  const queue = useRef<{ at: number; frame: Uint8Array; rates: Float32Array }[]>([]);
  // A poke is consumed by whichever bar is simulated next, so it always lands
  // on a bar line. That is a musical choice as much as a practical one.
  // Held for two bars: one bar of response is easy to miss, two is unmistakable.
  const pending = useRef<{ key: string; bars: number } | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  // Live controls read inside the async bar loop.
  const live = useRef({ bpm, brainMsPerBar, intensity, stimulusKey, rateHz, duty, moodIndex, cycle, cycleBars, kitIndex, livePace });
  useEffect(() => { live.current = { bpm, brainMsPerBar, intensity, stimulusKey, rateHz, duty, moodIndex, cycle, cycleBars, kitIndex, livePace }; },
            [bpm, brainMsPerBar, intensity, stimulusKey, rateHz, duty, moodIndex, cycle, cycleBars, kitIndex, livePace]);

  useEffect(() => {
    const c = new BrainClient(baseUrl, label => setStatus(`loading ${label}`));
    client.current = c;
    c.whenReady()
      .then(({ meta, backend }) => {
        channels.current = buildChannels(meta);
        setMeta(meta); setBackend(backend); setStatus('ready');
      })
      .catch(e => setStatus(`error: ${e.message}`));
    return () => { running.current = false; c.dispose(); media.current?.dispose(); };
  }, [baseUrl]);

  const stop = useCallback(() => {
    running.current = false;
    setPlaying(false);
    audio.current?.setVolume(0);
    media.current?.setPlaying(false);
    queue.current.length = 0;
  }, []);

  const start = useCallback(async () => {
    const c = client.current, m = meta;
    if (!c || !m || running.current) return;
    if (!audio.current) audio.current = new AudioEngine();
    const engine = audio.current;
    await engine.resume();
    engine.applyFx((KITS[live.current.kitIndex] ?? KITS[0]).fx);
    running.current = true;
    setPlaying(true);
    queue.current.length = 0;

    // Drain the activity queue against the audio clock.
    const pump = () => {
      if (!running.current) return;
      const now = engine.currentTime;
      let latest: { frame: Uint8Array; rates: Float32Array } | null = null;
      while (queue.current.length && queue.current[0].at <= now) latest = queue.current.shift()!;
      if (latest) { onActivity(latest.frame); motor.current = latest.rates; }
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);

    // OS media controls: media keys, lock screen, and the tab's pause button.
    if (!media.current) media.current = new MediaSessionController();
    void media.current.attach({
      play: () => { void startRef.current?.(); },
      pause: () => stopRef.current?.(),
      next: () => setKitIndex(i => (i + 1) % KITS.length),
      previous: () => setKitIndex(i => (i + KITS.length - 1) % KITS.length),
    });
    media.current.setPlaying(true);

    const stimulusNeurons = (key: string) => {
      const spec = STIMULI.find(s => s.key === key);
      return spec ? resolveTypes(m, spec.types) : [];
    };
    const sizes = new Map(channels.current.map(ch => [ch.name, ch.neurons.length]));

    let bar = 0, underruns = 0, overBudget = 0, autoReduced: number | null = null;
    // Set after the first window returns: the cold-start simulation is the
    // slowest one, and anchoring the clock before it guarantees an underrun.
    let nextBar = -1;

    while (running.current) {
      const { bpm, brainMsPerBar, intensity, stimulusKey, rateHz, duty, moodIndex, cycle, cycleBars, kitIndex, livePace } = live.current;
      const kit = KITS[kitIndex] ?? KITS[0];
      const activeStimulus = cycle ? stimulusForBar(bar, cycleBars) : stimulusKey;
      const mood = MOODS[moodIndex] ?? MOODS[0];
      const barSeconds = (60 / bpm) * BEATS;

      // Stay just over one bar ahead. The lookahead is what a poke has to wait
      // out — at 1.5 bars a click could miss two bars and take ~8 seconds to be
      // heard. A bar costs ~35% of its own length to simulate, so 1.05 leaves
      // ample margin and roughly halves that wait.
      if (nextBar > 0 && nextBar - engine.currentTime > barSeconds * 1.05) {
        await new Promise(r => setTimeout(r, 40));
        continue;
      }

      // The kernel drives one population per bar, so a poke is merged into the
      // background set and the whole thing is driven harder for that bar.
      const active = pending.current;
      const poke = active?.key ?? null;
      if (active) {
        active.bars -= 1;
        if (active.bars <= 0) { pending.current = null; setQueued(null); }
      }
      const pokeSpec = poke ? POKES.find(x => x.key === poke) : null;
      const driven = pokeSpec && m
        ? [...stimulusNeurons(activeStimulus), ...resolveTypes(m, pokeSpec.types)]
        : stimulusNeurons(activeStimulus);

      // Live pacing simulates the whole bar of brain time; the composer still
      // only sees `brainMsPerBar` of it, because a bar-long window averages the
      // structure out of the music.
      const simMs = livePace ? barSeconds * 1000 : brainMsPerBar;
      const result = await c.simulate({
        durationMs: simMs,
        musicWindowMs: livePace ? brainMsPerBar : undefined,
        dt: livePace ? LIVE_DT : undefined,
        stimulus: [{ neurons: driven, rateHz: pokeSpec ? Math.max(rateHz, 200) : rateHz }],
        dutyCycle: duty,
        channels: channels.current,
        maxEvents: 40000,
        activityFrames: ACTIVITY_FRAMES,
      });
      if (!running.current) break;

      const byChannel = new Map<string, { slot: number; at: number }[]>();
      for (const event of result.events) {
        const name = channels.current[event.channel]?.name;
        if (!name) continue;
        const list = byChannel.get(name);
        if (list) list.push(event);
        else byChannel.set(name, [event]);
      }

      const notes: Note[] = composeBar({
        // The window the NOTES came from, which under live pacing is a slice of
        // the window simulated. Passing the full bar here maps a 400 ms slice
        // onto the first sixth of the grid and bunches every note at the start.
        byChannel, channelSize: sizes, brainMs: Math.min(simMs, brainMsPerBar),
        barSeconds, bar, intensity, kit,
        scale: mood.scale, progression: mood.progression,
      });

      // Glitched audio is worse than less brain time per bar, so back off
      // automatically rather than just complaining. Only ever downwards: an
      // auto-raise would oscillate against a load that is already marginal.
      const load = result.wallMs / (barSeconds * 1000);
      if (livePace && load > LIVE_GIVE_UP) {
        // Protect the audio first: fall back to musical pacing and say so.
        setLivePace(false);
        setLiveDropped(true);
        live.current = { ...live.current, livePace: false };
        overBudget = 0;
      }
      overBudget = load > 0.85 ? overBudget + 1 : 0;
      if (overBudget >= 3 && brainMsPerBar > 60) {
        const reduced = Math.max(60, Math.round(brainMsPerBar * 0.75 / 20) * 20);
        if (reduced < brainMsPerBar) {
          autoReduced = reduced;
          setBrainMsPerBar(reduced);
          live.current = { ...live.current, brainMsPerBar: reduced };
        }
        overBudget = 0;
      }

      // If the window overran the lookahead, drop straight back to the clock
      // rather than scheduling notes in the past.
      if (nextBar < 0) nextBar = engine.currentTime + 0.12;
      else if (nextBar < engine.currentTime + 0.05) {
        underruns++;
        nextBar = engine.currentTime + 0.12;
      }
      engine.applyFx(kit.fx);
      for (const note of notes) engine.play(note, nextBar + note.at, kit);

      // The whole bar is simulated in one burst while the previous bar plays,
      // so its snapshots have to be released on the audio clock rather than as
      // they arrive — otherwise all eight land in the same millisecond.
      const rows = result.frameCount ? result.frames.length / result.frameCount : 0;
      const chans = channels.current.length;
      for (let f = 0; f < result.frameCount; f++) {
        queue.current.push({
          at: nextBar + (f / result.frameCount) * barSeconds,
          frame: result.frames.subarray(f * rows, (f + 1) * rows),
          rates: result.sliceRates.subarray(f * chans, (f + 1) * chans),
        });
      }
      setTelemetry({
        bar, chord: chordName(bar, mood.progression), stimulus: activeStimulus, realtime: result.brainMs / Math.max(1, result.wallMs),
        awake: result.awakeNeurons, spikes: result.totalSpikes, notes: notes.length,
        channelRates: Array.from(result.channelRates), underruns, load, autoReduced,
        poke,
      });

      media.current?.setMetadata(
        'LoFly',
        STIMULI.find(x => x.key === activeStimulus)?.label ?? activeStimulus,
        `${kit.name} · ${mood.key}`);

      nextBar += barSeconds;
      bar++;
    }
  }, [meta, onActivity]);

  useEffect(() => { startRef.current = start; stopRef.current = stop; }, [start, stop]);

  /**
   * Rough cost of live pacing, from the musical load already measured: a whole
   * bar of brain time instead of `brainMsPerBar`, at the coarser step. The
   * step's speedup measured ~2.15x rather than the 2.25x the ratio suggests.
   * Use 1.9 rather than either: in the browser the estimate came out ~25% under
   * what actually happened, and an estimate that errs toward warning is the
   * more useful one.
   */
  const livePrediction = (() => {
    const load = telemetry?.load;
    if (!load || livePace) return null;
    return load * ((bpm ? (60 / bpm) * BEATS : 2.5) * 1000 / brainMsPerBar) / 1.9;
  })();

  const reset = useCallback(() => { client.current?.reset(); }, []);
  const fire = useCallback((key: string) => {
    pending.current = { key, bars: 2 };
    setQueued(key);
  }, []);
  const audioSuspended = () => !!audio.current && audio.current.context.state !== 'running';

  return {
    meta, backend, status, playing, telemetry, start, stop, reset, audioSuspended,
    bpm, setBpm, brainMsPerBar, setBrainMsPerBar, intensity, setIntensity,
    duty, setDuty, moodIndex, setMoodIndex, moods: MOODS,
    cycle, setCycle, cycleBars, setCycleBars, cycleOrder: CYCLE_ORDER,
    kitIndex, setKitIndex, kits: KITS,
    livePace, liveDropped, motor, livePrediction,
    setLivePace: (v: boolean) => { setLivePace(v); if (v) setLiveDropped(false); },
    stimulusKey, setStimulusKey, rateHz, setRateHz,
    circuits: OUTPUT_CIRCUITS, stimuli: STIMULI, pokes: POKES, readouts: READOUTS,
    fire, queued,
    voices: (KITS[kitIndex] ?? KITS[0]).voices,
  };
}
