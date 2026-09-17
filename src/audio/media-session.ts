/**
 * Registers the page with the OS media controls.
 *
 * Web Audio alone does not create a media session: browsers key that off a
 * media *element*, so a page that synthesises everything through an
 * AudioContext gets no lock-screen controls, no media-key handling and no
 * pause button in the tab strip. The fix is a silent looping <audio> element
 * that exists purely to anchor the session — the real sound still goes out
 * through the AudioContext, untouched, so there is no added latency.
 *
 * Everything here is feature-detected; where MediaSession is missing the page
 * behaves exactly as before.
 */

export type MediaHandlers = {
  play: () => void;
  pause: () => void;
  next?: () => void;
  previous?: () => void;
};

/** A silent WAV, small enough to inline and long enough to loop cleanly. */
function silentWav(seconds = 1, rate = 8000): string {
  const samples = Math.floor(seconds * rate);
  const size = 44 + samples * 2;
  const view = new DataView(new ArrayBuffer(size));
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF'); view.setUint32(4, size - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  const bytes = new Uint8Array(view.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Draw the artwork rather than shipping one: a soma scatter, like the brain view. */
function artwork(size = 512): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const g = canvas.getContext('2d');
      if (!g) return resolve(null);
      g.fillStyle = '#0b0e12';
      g.fillRect(0, 0, size, size);
      let seed = 9;
      const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      for (let i = 0; i < 1400; i++) {
        const a = random() * Math.PI * 2;
        const r = Math.pow(random(), 0.55) * size * 0.42;
        const x = size / 2 + Math.cos(a) * r * 1.15;
        const y = size / 2 + Math.sin(a) * r * 0.78;
        const hot = random();
        g.fillStyle = hot > 0.86 ? 'rgba(210,250,255,0.95)' : `rgba(60,130,200,${0.25 + hot * 0.4})`;
        g.beginPath();
        g.arc(x, y, hot > 0.86 ? 2.6 : 1.5, 0, Math.PI * 2);
        g.fill();
      }
      canvas.toBlob(blob => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

export class MediaSessionController {
  private anchor: HTMLAudioElement | null = null;
  private art: string | null = null;
  private supported = typeof navigator !== 'undefined' && 'mediaSession' in navigator;

  async attach(handlers: MediaHandlers) {
    if (!this.supported) return;
    if (!this.anchor) {
      const audio = new Audio(silentWav());
      audio.loop = true;
      // Keep it out of the accessibility tree and off screen; it is not content.
      audio.setAttribute('aria-hidden', 'true');
      audio.style.display = 'none';
      // Attached rather than free-floating: some browsers only grant a session
      // to an element in the document, and it makes the anchor inspectable.
      document.body.appendChild(audio);
      this.anchor = audio;
    }
    try { await this.anchor.play(); } catch { /* autoplay refused; controls simply stay off */ }

    if (!this.art) this.art = await artwork();

    const set = (action: MediaSessionAction, handler: (() => void) | undefined) => {
      try { navigator.mediaSession.setActionHandler(action, handler ?? null); } catch { /* unsupported action */ }
    };
    set('play', handlers.play);
    set('pause', handlers.pause);
    set('stop', handlers.pause);
    set('nexttrack', handlers.next);
    set('previoustrack', handlers.previous);
  }

  private lastMetadata = '';

  /** `artist` carries the circuit currently driving, `album` the kit. */
  setMetadata(title: string, artist: string, album: string) {
    if (!this.supported || typeof MediaMetadata === 'undefined') return;
    const key = `${title}|${artist}|${album}`;
    if (key === this.lastMetadata) return;
    this.lastMetadata = key;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title, artist, album,
        artwork: this.art ? [{ src: this.art, sizes: '512x512', type: 'image/png' }] : [],
      });
    } catch { /* metadata is decorative */ }
  }

  setPlaying(playing: boolean) {
    if (!this.supported) return;
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch { /* ignore */ }
    if (!playing) this.anchor?.pause();
    else void this.anchor?.play().catch(() => {});
  }

  /** True when the silent anchor is actually running, which is what grants the session. */
  get anchored() { return !!this.anchor && !this.anchor.paused; }

  dispose() {
    this.anchor?.pause();
    this.anchor?.remove();
    this.anchor = null;
    if (this.art) { URL.revokeObjectURL(this.art); this.art = null; }
    if (!this.supported) return;
    for (const action of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'] as MediaSessionAction[]) {
      try { navigator.mediaSession.setActionHandler(action, null); } catch { /* ignore */ }
    }
    try { navigator.mediaSession.playbackState = 'none'; } catch { /* ignore */ }
  }
}
