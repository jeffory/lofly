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
  CYCLE_ORDER, OUTPUT_CIRCUITS, STIMULI, buildChannels, resolveTypes, stimulusForBar,
} from '../sim/circuits';
import type { Backend, Channel, ConnectomeMeta } from '../sim/types';

export type Telemetry = {
  bar: number;
  chord: string;
  /** The circuit actually driven this bar, which the cycle preset rotates. */
  stimulus: string;
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

/** How many activity snapshots each bar is split into for the brain view. */
const ACTIVITY_FRAMES = 8;

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
  const [stimulusKey, setStimulusKey] = useState('pIP10');
  const [rateHz, setRateHz] = useState(150);

  const startRef = useRef<(() => Promise<void>) | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const client = useRef<BrainClient | null>(null);
  const audio = useRef<AudioEngine | null>(null);
  const media = useRef<MediaSessionController | null>(null);
  const channels = useRef<Channel[]>([]);
  const running = useRef(false);
  const queue = useRef<{ at: number; frame: Uint8Array }[]>([]);
  // Live controls read inside the async bar loop.
  const live = useRef({ bpm, brainMsPerBar, intensity, stimulusKey, rateHz, duty, moodIndex, cycle, cycleBars, kitIndex });
  useEffect(() => { live.current = { bpm, brainMsPerBar, intensity, stimulusKey, rateHz, duty, moodIndex, cycle, cycleBars, kitIndex }; },
            [bpm, brainMsPerBar, intensity, stimulusKey, rateHz, duty, moodIndex, cycle, cycleBars, kitIndex]);

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
      let latest: Uint8Array | null = null;
      while (queue.current.length && queue.current[0].at <= now) latest = queue.current.shift()!.frame;
      if (latest) onActivity(latest);
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
      const { bpm, brainMsPerBar, intensity, stimulusKey, rateHz, duty, moodIndex, cycle, cycleBars, kitIndex } = live.current;
      const kit = KITS[kitIndex] ?? KITS[0];
      const activeStimulus = cycle ? stimulusForBar(bar, cycleBars) : stimulusKey;
      const mood = MOODS[moodIndex] ?? MOODS[0];
      const barSeconds = (60 / bpm) * BEATS;

      // Stay at most ~1.5 bars ahead so control changes are felt quickly.
      if (nextBar > 0 && nextBar - engine.currentTime > barSeconds * 1.5) {
        await new Promise(r => setTimeout(r, 40));
        continue;
      }

      const result = await c.simulate({
        durationMs: brainMsPerBar,
        stimulus: [{ neurons: stimulusNeurons(activeStimulus), rateHz }],
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
        byChannel, channelSize: sizes, brainMs: result.brainMs,
        barSeconds, bar, intensity, kit,
        scale: mood.scale, progression: mood.progression,
      });

      // Glitched audio is worse than less brain time per bar, so back off
      // automatically rather than just complaining. Only ever downwards: an
      // auto-raise would oscillate against a load that is already marginal.
      const load = result.wallMs / (barSeconds * 1000);
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
      for (let f = 0; f < result.frameCount; f++) {
        queue.current.push({
          at: nextBar + (f / result.frameCount) * barSeconds,
          frame: result.frames.subarray(f * rows, (f + 1) * rows),
        });
      }
      setTelemetry({
        bar, chord: chordName(bar, mood.progression), stimulus: activeStimulus, realtime: result.brainMs / Math.max(1, result.wallMs),
        awake: result.awakeNeurons, spikes: result.totalSpikes, notes: notes.length,
        channelRates: Array.from(result.channelRates), underruns, load, autoReduced,
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

  const reset = useCallback(() => { client.current?.reset(); }, []);
  const audioSuspended = () => !!audio.current && audio.current.context.state !== 'running';

  return {
    meta, backend, status, playing, telemetry, start, stop, reset, audioSuspended,
    bpm, setBpm, brainMsPerBar, setBrainMsPerBar, intensity, setIntensity,
    duty, setDuty, moodIndex, setMoodIndex, moods: MOODS,
    cycle, setCycle, cycleBars, setCycleBars, cycleOrder: CYCLE_ORDER,
    kitIndex, setKitIndex, kits: KITS,
    stimulusKey, setStimulusKey, rateHz, setRateHz,
    circuits: OUTPUT_CIRCUITS, stimuli: STIMULI,
    voices: (KITS[kitIndex] ?? KITS[0]).voices,
  };
}
