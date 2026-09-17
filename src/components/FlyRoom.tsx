/**
 * The room the fly flies through, drawn on a 2D canvas.
 *
 * Rendering and input only: the rules live in src/game/world.ts so they can be
 * tested without a browser. Every sense the flight triggers is handed straight
 * to `onSense`, which fires the same pokes the buttons do — so the music
 * becomes a record of the flight rather than a separate random process.
 */
import { useEffect, useRef, useState } from 'react';
import { createWorld, flap, step, WORLD, type Sense, type World } from '../game/world';
import { createPilot, fly, EPISODE, type Pilot } from '../game/pilot';

const COLOURS: Record<Sense, string> = {
  threat: '#ff6b57', smell: '#7ad97a', warmth: '#ffb765',
  buzz: '#9db4ff', taste: '#ffe08a', touch: '#8fa3b8',
};

export function FlyRoom({ running, onSense, wingRate, brainDrive, readBrain }: {
  running: boolean;
  onSense: (s: Sense) => void;
  /** Power-muscle firing, 0–1. Blurs the wings. */
  wingRate: number;
  /**
   * A zero-centred brain signal, -1..1, that the pilot may lean on.
   *
   * Power-muscle rate is useless here: it sits near its ceiling almost always,
   * so as a policy input it is not a signal at all, just a constant bias toward
   * flapping — which measured as 9 bumps in 42 s against 0 without it. The
   * steering-muscle balance does vary with what is driving the brain, and being
   * zero-mean it modulates rather than pushes.
   */
  brainDrive: number;
  /**
   * When live pacing is on, a getter for the brain's current steering balance.
   * Reading it per frame is the point: the per-bar `brainDrive` prop only
   * changes once every 2.5 s, which is too slow to steer with.
   */
  readBrain: (() => number) | null;
}) {
  const host = useRef<HTMLCanvasElement>(null);
  const world = useRef<World>(createWorld(Date.now() >>> 0));
  const sense = useRef(onSense);
  const live = useRef({ running, wingRate, brainDrive });
  const read = useRef(readBrain);
  const [stats, setStats] = useState({ distance: 0, bumps: 0, collected: 0, passed: 0 });
  const pilot = useRef<Pilot>(createPilot(Date.now() >>> 0));
  const [auto, setAuto] = useState(true);
  const [learning, setLearning] = useState({ episode: 0, best: 0, recent: [] as number[] });
  const autoRef = useRef(auto);
  useEffect(() => { autoRef.current = auto; }, [auto]);

  useEffect(() => { sense.current = onSense; }, [onSense]);
  useEffect(() => { live.current = { running, wingRate, brainDrive }; }, [running, wingRate, brainDrive]);
  useEffect(() => { read.current = readBrain; }, [readBrain]);

  useEffect(() => {
    const canvas = host.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;

    const press = (event: Event) => { event.preventDefault(); flap(world.current); };
    const key = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.code === 'ArrowUp') { event.preventDefault(); flap(world.current); }
    };
    canvas.addEventListener('pointerdown', press);
    window.addEventListener('keydown', key);

    let raf = 0, previous = performance.now(), sinceStats = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      const w = world.current;

      if (live.current.running && !document.hidden) {
        // The brain biases the pilot on a slow channel, so flight and
        // connectome influence each other rather than running side by side.
        const fired = autoRef.current
          ? fly(pilot.current, w, dt, read.current ? read.current() : live.current.brainDrive)
          : step(w, dt);
        for (const s of fired) sense.current(s);
        sinceStats += dt;
        if (sinceStats > 0.25) {
          sinceStats = 0;
          const collected = Object.entries(w.collected)
            .filter(([k]) => k !== 'touch').reduce((a, [, n]) => a + n, 0);
          setStats({ distance: w.distance, bumps: w.bumps, collected, passed: w.passed });
          const p = pilot.current;
          setLearning({ episode: p.episode, best: p.bestScore === -Infinity ? 0 : p.bestScore,
                        recent: p.history.slice(-24) });
        }
      }

      const { width, height } = canvas.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio, 2);
      if (canvas.width !== Math.round(width * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(g, width, height, w, live.current.wingRate, now / 1000);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', press);
      window.removeEventListener('keydown', key);
    };
  }, []);

  return <div className="room">
    <canvas ref={host} className="room-canvas" aria-label="Fly through the room; click or press space to flap"/>
    <div className="room-stats">
      <span>{stats.passed} cleared</span>
      <span>{stats.collected} picked up</span>
      <span>{stats.bumps} bumps</span>
      {auto
        ? <span className="room-learn" title="Reward is a column cleared; a bump costs three">
            gen {learning.episode} · best {learning.best.toFixed(0)}
            <Spark values={learning.recent}/>
          </span>
        : <span className="room-hint">click / space to flap</span>}
      <span className="room-controls">
        <button aria-pressed={auto} onClick={() => setAuto(v => !v)}>
          {auto ? 'Autopilot' : 'Manual'}
        </button>
        <button title="Start learning again from zero weights"
                onClick={() => { pilot.current = createPilot(Date.now() >>> 0, true); }}>
          Relearn
        </button>
      </span>
    </div>
  </div>;
}

/** Fitness of recent episodes, so the search is visible rather than asserted. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const points = values.map((v, i) =>
    `${(i / (values.length - 1)) * 46},${10 - ((v - lo) / span) * 9}`).join(' ');
  return <svg className="spark" viewBox="0 0 46 10" aria-hidden="true">
    <polyline points={points} fill="none" stroke="#84d7ef" strokeWidth="1"/>
  </svg>;
}

function draw(g: CanvasRenderingContext2D, W: number, H: number,
              w: World, wing: number, time: number) {
  g.clearRect(0, 0, W, H);

  // Floor and ceiling, so the walls read as surfaces rather than edges.
  g.fillStyle = '#131a22';
  g.fillRect(0, 0, W, H * WORLD.flyRadius);
  g.fillRect(0, H * (1 - WORLD.flyRadius), W, H * WORLD.flyRadius);

  // Parallax marks, to make the scroll legible without drawing a whole room.
  g.strokeStyle = '#1b242e';
  g.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    const x = ((i / 14 - (w.distance * 0.35) % (1 / 14)) % 1 + 1) % 1;
    g.beginPath(); g.moveTo(x * W, H * 0.06); g.lineTo(x * W, H * 0.94); g.stroke();
  }

  for (const o of w.obstacles) {
    const x = o.x * W, gap = o.gapCentre * H, half = WORLD.gapHalfHeight * H;
    g.fillStyle = o.hit ? '#3a2b2b' : '#22303c';
    g.strokeStyle = o.hit ? '#7d483b' : '#33465a';
    const bw = 0.055 * 2 * W;
    // A gap near an edge leaves a zero-height column; stroking that still
    // paints a 1px line across the canvas, so skip anything without height.
    const column = (top: number, h: number) => {
      if (h <= 0.5) return;
      g.fillRect(x - bw / 2, top, bw, h);
      g.strokeRect(x - bw / 2, top, bw, h);
    };
    column(0, gap - half);
    column(gap + half, H - gap - half);
  }

  for (const p of w.pickups) {
    const x = p.x * W, y = p.y * H, r = 0.035 * H;
    const pulse = 0.75 + 0.25 * Math.sin(time * 4 + p.x * 20);
    g.fillStyle = COLOURS[p.sense];
    // The halo is the catch radius, drawn honestly: pass inside it and you have it.
    g.globalAlpha = 0.16 * pulse;
    g.beginPath(); g.arc(x, y, (WORLD.pickupReach + WORLD.flyRadius) * H, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    g.beginPath(); g.arc(x, y, r * pulse, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0b0e12';
    g.font = `${Math.round(r * 0.9)}px ui-monospace, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(p.sense[0].toUpperCase(), x, y + 1);
  }

  // The fly: a body, and wings whose blur tracks the power muscles.
  const fx = WORLD.flyX * W, fy = w.y * H, r = WORLD.flyRadius * H;
  const beat = Math.sin(time * (14 + wing * 26)) * (0.35 + wing * 0.65);
  g.save();
  g.translate(fx, fy);
  g.rotate(Math.max(-0.5, Math.min(0.6, w.vy * 0.5)));
  g.fillStyle = 'rgba(190,210,230,.5)';
  for (const side of [-1, 1]) {
    g.beginPath();
    g.ellipse(-r * 0.15, side * r * 0.5 * (0.5 + Math.abs(beat)), r * 0.95, r * 0.34, side * beat * 0.5, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#d8a15c';
  g.beginPath(); g.ellipse(0, 0, r, r * 0.72, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#b8342a';
  g.beginPath(); g.arc(r * 0.72, -r * 0.12, r * 0.34, 0, Math.PI * 2); g.fill();
  g.restore();

  if (w.cooldown > 0) {
    g.strokeStyle = `rgba(255,120,90,${w.cooldown / WORLD.bumpCooldown})`;
    g.lineWidth = 2;
    g.beginPath(); g.arc(fx, fy, r * 2.1, 0, Math.PI * 2); g.stroke();
  }
}
