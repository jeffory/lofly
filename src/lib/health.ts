/**
 * Runtime health for the simulation, the renderer and the audio clock.
 *
 * These three degrade independently and want different remedies, so they are
 * reported separately rather than as one "slow" flag:
 *
 *  - The simulation runs in a worker. When a bar's window takes longer than the
 *    bar lasts, audio scheduling falls behind and you hear it. This is the only
 *    failure that damages output, so it is the one worth acting on automatically.
 *  - The renderer runs on the main thread. When it stalls the visuals stutter
 *    but the audio, already scheduled ahead, is untouched.
 *  - A lost WebGL context is a hard failure: the canvas is dead until restored.
 *
 * A warning nobody can act on is noise, so every message carries its remedy.
 */

export type HealthLevel = 'ok' | 'warn' | 'critical';

export type HealthMessage = { level: Exclude<HealthLevel, 'ok'>; text: string; remedy: string };

export type Health = {
  level: HealthLevel;
  fps: number;
  /** Fraction of the bar spent simulating it. Above 1.0 the audio cannot keep up. */
  simLoad: number;
  underruns: number;
  longFrames: number;
  softwareRenderer: string | null;
  contextLost: boolean;
  messages: HealthMessage[];
};

/**
 * Ask the GPU what it is. A software rasteriser (SwiftShader, llvmpipe, or
 * Apple's software fallback) will draw 124k points on the CPU, competing with
 * the very worker that has to keep audio fed.
 */
export function detectSoftwareRenderer(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'no WebGL';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (!info) return null;
    const renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    return /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(renderer)
      ? renderer : null;
  } catch {
    return null;
  }
}

/** Samples main-thread frame rate and long animation frames. */
export class RenderHealthMonitor {
  private frames = 0;
  private since = performance.now();
  private raf = 0;
  private observer: PerformanceObserver | null = null;
  private running = false;

  fps = 60;
  longFrames = 0;

  start() {
    if (this.running) return;
    this.running = true;
    this.since = performance.now();
    this.frames = 0;
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      // A hidden tab throttles rAF to near zero; that is not a health problem.
      if (document.hidden) { this.since = performance.now(); this.frames = 0; return; }
      this.frames++;
      const elapsed = performance.now() - this.since;
      if (elapsed >= 1000) {
        this.fps = (this.frames * 1000) / elapsed;
        this.frames = 0;
        this.since = performance.now();
      }
    };
    this.raf = requestAnimationFrame(tick);

    // long-animation-frame attributes the stall; longtask is the older fallback.
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    const type = supported.includes('long-animation-frame') ? 'long-animation-frame'
      : supported.includes('longtask') ? 'longtask' : null;
    if (type) {
      try {
        this.observer = new PerformanceObserver(list => { this.longFrames += list.getEntries().length; });
        this.observer.observe({ type, buffered: false });
      } catch { this.observer = null; }
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Long frames since the last call. */
  takeLongFrames() { const n = this.longFrames; this.longFrames = 0; return n; }
}

export type HealthInput = {
  playing: boolean;
  fps: number;
  longFrames: number;
  simLoad: number;
  underruns: number;
  softwareRenderer: string | null;
  contextLost: boolean;
  audioSuspended: boolean;
  /** True once the conductor has already cut the window to cope. */
  autoReduced: number | null;
};

export function assessHealth(input: HealthInput): Health {
  const messages: HealthMessage[] = [];

  if (input.contextLost) {
    messages.push({
      level: 'critical',
      text: 'The graphics context was lost.',
      remedy: 'The brain view will restore itself if the driver recovers; reload if it does not. Audio is unaffected.',
    });
  }

  if (input.audioSuspended) {
    messages.push({
      level: 'warn',
      text: 'Audio output is suspended.',
      remedy: 'Click Play to resume; browsers suspend audio when a tab loses focus.',
    });
  }

  if (input.playing && input.underruns > 0) {
    messages.push({
      level: 'critical',
      text: `Audio has fallen behind ${input.underruns} time${input.underruns > 1 ? 's' : ''}.`,
      remedy: input.autoReduced
        ? `Brain time per bar was cut to ${input.autoReduced} ms automatically. Lower it further, or reduce the tempo.`
        : 'Lower "Brain time per bar", or raise the tempo so each bar covers less work.',
    });
  } else if (input.playing && input.simLoad > 0.8) {
    messages.push({
      level: 'warn',
      text: `The simulation is using ${Math.round(input.simLoad * 100)}% of each bar.`,
      remedy: 'Audio is still on time but has little margin. Lower "Brain time per bar" if it starts to glitch.',
    });
  }

  if (input.softwareRenderer) {
    messages.push({
      level: 'warn',
      text: 'No GPU acceleration; WebGL is running on the CPU.',
      remedy: 'The brain view will be slow and will steal time from the simulation. Enable hardware acceleration in your browser settings.',
    });
  } else if (input.playing && input.fps < 45 && input.fps > 0) {
    messages.push({
      level: 'warn',
      text: `Display is at ${Math.round(input.fps)} fps.`,
      remedy: 'Visuals only — audio is scheduled ahead and is not affected. Turn off Orbit, or narrow the window.',
    });
  }

  const level: HealthLevel = messages.some(m => m.level === 'critical') ? 'critical'
    : messages.length ? 'warn' : 'ok';
  return {
    level, fps: input.fps, simLoad: input.simLoad, underruns: input.underruns,
    longFrames: input.longFrames, softwareRenderer: input.softwareRenderer,
    contextLost: input.contextLost, messages,
  };
}
