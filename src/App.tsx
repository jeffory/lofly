import { useCallback, useEffect, useRef, useState } from 'react';
import { BrainScene } from './components/BrainScene';
import { FlyScene } from './components/FlyScene';
import { Attribution } from './components/Attribution';
import { useConductor } from './components/Conductor';
import { resolveTypes } from './sim/circuits';
import {
  RenderHealthMonitor, assessHealth, detectSoftwareRenderer,
} from './lib/health';
import type { WingDrive } from './components/FlyScene';
import { VOICE_CHANNELS, type VoiceRole } from './audio/kits';
import { assetBase, loadAtlas, type Atlas } from './lib/atlas';

export function App() {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [error, setError] = useState('');
  const [activity, setActivity] = useState<Uint8Array | null>(null);

  // Snapshots arrive several times a bar, already paced against the audio
  // clock, so hand them straight through; BrainScene eases between them.
  const onActivity = useCallback((next: Uint8Array) => setActivity(next), []);

  const c = useConductor(assetBase(), onActivity);

  // Render health is sampled on the main thread; simulation health arrives with
  // each bar's telemetry. They fail independently, so they are assessed together
  // but reported as separate, separately actionable conditions.
  const monitor = useRef<RenderHealthMonitor | null>(null);
  const [render, setRender] = useState({ fps: 60, longFrames: 0 });
  const [contextLost, setContextLost] = useState(false);
  const [software] = useState(detectSoftwareRenderer);

  useEffect(() => {
    const m = new RenderHealthMonitor();
    m.start();
    monitor.current = m;
    const id = setInterval(() => setRender({ fps: m.fps, longFrames: m.takeLongFrames() }), 1000);
    return () => { clearInterval(id); m.stop(); };
  }, []);

  const health = assessHealth({
    playing: c.playing,
    fps: render.fps,
    longFrames: render.longFrames,
    simLoad: c.telemetry?.load ?? 0,
    underruns: c.telemetry?.underruns ?? 0,
    softwareRenderer: software,
    contextLost,
    audioSuspended: c.playing && c.audioSuspended(),
    autoReduced: c.telemetry?.autoReduced ?? null,
  });

  useEffect(() => {
    const abort = new AbortController();
    void loadAtlas(abort.signal).then(setAtlas)
      .catch(e => { if (!abort.signal.aborted) setError(String(e)); });
    return () => abort.abort();
  }, []);

  // Drive the wings from the muscles that actually move them: power-muscle
  // (DLMn/DVMn) rate sets stroke amplitude, and the balance between the two
  // steering groups sets tilt. These are the same spike trains feeding the
  // hat, perc and pluck voices, so the fly beats in time with its own drums.
  const rateOf = (key: string) => {
    const i = c.circuits.findIndex(x => x.key === key);
    if (i < 0 || !c.telemetry || !c.meta) return 0;
    const size = resolveTypes(c.meta, c.circuits[i].types).length;
    return size ? c.telemetry.channelRates[i] / size : 0;
  };
  const power = rateOf('power'), basal = rateOf('steer-basal'), fine = rateOf('steer-fine');
  const wing: WingDrive = c.playing
    ? { power: Math.min(1, power / 320),
        tilt: Math.max(-1, Math.min(1, (basal - fine) / 60)) }
    : { power: 0, tilt: 0 };

  const loading = c.status.startsWith('loading');
  const failed = c.status.startsWith('error');

  return <>
    <header>
      <h1>LOFLY</h1>
      <span>A male fly&rsquo;s song circuit, playing a song</span>
    </header>
    <main>
      <div className="toolbar">
        <span className="status">
          {failed ? c.status : c.playing
            ? `Bar ${(c.telemetry?.bar ?? 0) + 1} · ${c.telemetry?.chord ?? ''}`
              + (c.cycle && c.telemetry ? ` · ${c.stimuli.find(s => s.key === c.telemetry!.stimulus)?.label ?? c.telemetry.stimulus}` : '')
            : loading ? c.status : 'Ready'}
        </span>
        <div className="controls">
          <button disabled={!c.meta || c.playing} onClick={() => void c.start()}>Play</button>
          <button disabled={!c.playing} onClick={c.stop}>Stop</button>
          <button disabled={c.playing || !c.meta} onClick={c.reset}>Reset brain</button>
        </div>
      </div>
      {(error || failed) && <p className="error" role="alert">{error || c.status}</p>}
      {health.level !== 'ok' && <div className={`health health-${health.level}`} role="status">
        {health.messages.map(m => <p key={m.text}>
          <b>{m.text}</b> <span>{m.remedy}</span>
        </p>)}
      </div>}

      <div className="workbench">
        <section className="panel environment-panel">
          <h2>01 / DRIVE</h2>
          <div className="drive">
            <label>Stimulate
              <select aria-label="Stimulus circuit" value={c.cycle ? '__cycle' : c.stimulusKey}
                      onChange={e => {
                        if (e.target.value === '__cycle') c.setCycle(true);
                        else { c.setCycle(false); c.setStimulusKey(e.target.value); }
                      }}>
                <option value="__cycle">Cycle through circuits</option>
                {c.stimuli.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <p className="hint">
              {c.cycle
                ? (() => {
                    // The pair only realigns at the LCM of the two periods.
                    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
                    const cycleLen = c.cycleOrder.length * c.cycleBars;
                    const chords = c.moods[c.moodIndex]?.progression.length ?? 8;
                    const realign = (cycleLen * chords) / gcd(cycleLen, chords);
                    return `Rotates ${c.cycleOrder.length} circuits every ${c.cycleBars} bar${c.cycleBars > 1 ? 's' : ''} against a ${chords}-bar progression; the two only realign every ${realign} bars.`;
                  })()
                : c.stimuli.find(s => s.key === c.stimulusKey)?.note}
            </p>
            {c.cycle && <label>Bars per circuit <b>{c.cycleBars}</b>
              <input type="range" min="1" max="8" step="1" value={c.cycleBars}
                     onChange={e => c.setCycleBars(Number(e.target.value))}/>
            </label>}
            <label>Kit
              <select aria-label="Instrument kit" value={c.kitIndex}
                      onChange={e => c.setKitIndex(Number(e.target.value))}>
                {c.kits.map((k, i) => <option key={k.name} value={i}>{k.name}</option>)}
              </select>
            </label>
            <p className="hint">{c.kits[c.kitIndex]?.blurb}</p>
            <label>Key
              <select aria-label="Musical key" value={c.moodIndex}
                      onChange={e => c.setMoodIndex(Number(e.target.value))}>
                {c.moods.map((m, i) => <option key={m.key} value={i}>{m.key}</option>)}
              </select>
            </label>
            <label>Drive rate <b>{c.rateHz} Hz</b>
              <input type="range" min="20" max="300" step="10" value={c.rateHz}
                     onChange={e => c.setRateHz(Number(e.target.value))}/>
            </label>
            <label>Tempo <b>{c.bpm} BPM</b>
              <input type="range" min="60" max="140" step="2" value={c.bpm}
                     onChange={e => c.setBpm(Number(e.target.value))}/>
            </label>
            <label>Burst length <b>{Math.round(c.duty * 100)}% of bar</b>
              <input type="range" min="0.1" max="1" step="0.05" value={c.duty}
                     onChange={e => c.setDuty(Number(e.target.value))}/>
            </label>
            <label>Note density <b>{c.intensity.toFixed(2)}×</b>
              <input type="range" min="0.2" max="2" step="0.05" value={c.intensity}
                     onChange={e => c.setIntensity(Number(e.target.value))}/>
            </label>
            <label>Brain time per bar <b>{c.brainMsPerBar} ms</b>
              <input type="range" min="60" max="1200" step="20" value={c.brainMsPerBar}
                     onChange={e => c.setBrainMsPerBar(Number(e.target.value))}/>
            </label>
          </div>
          <div className="panel-bottom">
            Poisson drive into a named circuit · everything downstream is the connectome
          </div>
        </section>

        <section className="panel brain-panel">
          <h2>02 / BRAIN <span>MaleCNS v1.0</span></h2>
          {atlas ? <BrainScene atlas={atlas} frame={null} activity={activity}
                               onContextLost={setContextLost}/>
                 : <p className="loading" role="status">Loading measured anatomy…</p>}
          <div className="panel-bottom">
            {c.meta
              ? `${c.meta.nodes.toLocaleString('en-US')} neurons · ${c.meta.edges.toLocaleString('en-US')} synapses simulated`
              : c.status}
          </div>
        </section>

        <section className="panel fly-panel">
          <h2>03 / VOICES</h2>
          <div className="voices">
            {c.circuits.map((circuit, i) => {
              const total = c.telemetry?.channelRates[i] ?? 0;
              const size = c.meta ? resolveTypes(c.meta, circuit.types).length : 0;
              const rate = size ? total / size : 0;
              const voice = c.voices.find((v: { role: string }) => VOICE_CHANNELS[v.role as VoiceRole] === circuit.key);
              return <div key={circuit.key} className="voice">
                <span className="voice-name">{circuit.label}</span>
                <span className="voice-role">{voice?.role ?? '—'}</span>
                <span className="meter"><i style={{ width: `${Math.min(100, rate / 2.5)}%` }}/></span>
                <span className="voice-rate">{rate.toFixed(0)} Hz</span>
              </div>;
            })}
          </div>
          <div className="fly-mini"><FlyScene wing={wing}/></div>
          <div className="panel-bottom">
            <span>Population spike rate per bar · drives note choice</span>
            <span>Wings: motor neuron drive</span>
          </div>
        </section>
      </div>

      <section className="model-status" aria-label="Model provenance">
        <strong>{c.playing ? 'PREDICTED OUTPUT' : 'IDLE'}</strong>
        <p>
          Leaky integrate-and-fire over the MaleCNS v1.0 connectome, parameters from
          Shiu et al. 2024. Simulated activity, not a recording from a living fly.
          {c.backend === 'wasm-simd'
            ? ' Running the WebAssembly SIMD kernel.'
            : c.backend === 'typescript'
              ? ' SIMD unavailable; running the portable TypeScript engine.'
              : ''}
        </p>
        {c.telemetry && <p className="telemetry">
          {c.telemetry.spikes.toLocaleString('en-US')} spikes/bar ·
          {c.telemetry.awake > 0 && ` ${c.telemetry.awake.toLocaleString('en-US')} neurons awake ·`}
          {' '}{c.telemetry.notes} notes ·
          {' '}{c.telemetry.realtime.toFixed(2)}× real time ·
          {' '}{Math.round(c.telemetry.load * 100)}% of bar · {Math.round(render.fps)} fps
          {c.telemetry.underruns > 0 && ` · ${c.telemetry.underruns} underruns`}
        </p>}
      </section>

      <details>
        <summary>What is actually happening</summary>
        <p>
          MaleCNS is a <em>male</em> connectome, and male flies sing by vibrating a wing.
          pIP10 is the descending command neuron that starts courtship song; dPR1, dMS9,
          pMP2, TN1a, vPR9, vMS12 and dMS2 are the thoracic song circuit it drives, and
          the wing motor neurons are the muscles that make the sound. Those are the six
          channels above — the fly&rsquo;s own output bus, not an arbitrary mapping.
        </p>
        <p>
          Each bar, a short window of brain time is simulated. Spikes are histogrammed
          onto a musical grid and only the busiest cells become notes, with pitch chosen
          by which neuron in the population fired. The grid, key and chord progression
          are imposed; the rhythm and melodic contour are the connectome&rsquo;s.
        </p>
        <p>
          Dataset creators: FlyEM / HHMI Janelia, University of Cambridge, MRC Laboratory
          of Molecular Biology and Google Research.{' '}
          <a href="https://male-cns.janelia.org/download/">MaleCNS data</a>, CC BY 4.0.
        </p>
      </details>
    </main>
    <Attribution/>
  </>;
}
