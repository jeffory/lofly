/** Shared types for the connectome spiking simulation. */

export type LifParams = {
  vRest: number; vReset: number; vThreshold: number;
  tauM: number; tauSyn: number; refractory: number;
  delay: number; mvPerSynapse: number; dt: number;
  units: string;
};

export type ConnectomeMeta = {
  dataset: string;
  threshold: number;
  nodes: number;
  edges: number;
  excitatoryEdges: number;
  inhibitoryEdges: number;
  viewerRows: number;
  groups: string[];
  lif: LifParams;
  attribution: string;
  /** Cell type name -> simulation node indices. */
  types: Record<string, number[]>;
};

/** One spike from a watched output channel, stamped in brain time. */
export type SpikeEvent = {
  /** Index into the request's `channels` array. */
  channel: number;
  /** Position of the firing neuron within that channel's neuron list. */
  slot: number;
  /** Milliseconds of brain time since the start of this window. */
  at: number;
};

export type Channel = {
  name: string;
  /** Simulation node indices this channel listens to. */
  neurons: number[];
};

export type SimRequest = {
  /** Brain-time milliseconds to advance. */
  durationMs: number;
  /** Neurons driven with Poisson input, and at what rate. */
  stimulus: { neurons: number[]; rateHz: number }[];
  /**
   * Fraction of the window during which the stimulus is applied, 0–1.
   * Sustained drive saturates the network into uniform firing; bursting it and
   * letting the circuit ring out is what produces structure worth listening to.
   */
  dutyCycle?: number;
  channels: Channel[];
  /** Cap on returned events so a runaway window cannot flood the main thread. */
  maxEvents: number;
  /**
   * Split the window into this many activity snapshots. The music still sees
   * the whole bar, but the brain view gets a frame per sub-window so it can
   * animate across the bar instead of holding one value for 2.5 seconds.
   */
  activityFrames?: number;
};

/** What one engine call returns, for a single window. */
export type SliceResult = {
  events: SpikeEvent[];
  /** Per-channel spike count over the window, for meters and velocity. */
  channelRates: Float32Array;
  /** Normalized recent activity per viewer row, ready for the GPU. */
  activity: Float32Array;
  /** Whole-network spike count and the brain time actually simulated. */
  totalSpikes: number;
  brainMs: number;
  /** Wall-clock milliseconds the window took, for the real-time meter. */
  wallMs: number;
  truncated: boolean;
  /** Size of the awake set at the end of the window, for the load meter. */
  awakeNeurons: number;
};

/** A whole bar, assembled by the worker from one or more slices. */
export type SimResult = SliceResult & {
  /**
   * `frameCount` sub-window snapshots, concatenated, one byte per viewer row
   * (0-255). Bytes rather than floats because this is per-bar traffic and the
   * shader only needs 8 bits of brightness.
   */
  frames: Uint8Array;
  frameCount: number;
};

export type WorkerIn =
  | { type: 'init'; baseUrl: string }
  | { type: 'simulate'; id: number; request: SimRequest }
  | { type: 'reset' };

/** Which kernel actually ran; surfaced so the UI can report real-time factor honestly. */
export type Backend = 'wasm-simd' | 'typescript';

export type WorkerOut =
  | { type: 'ready'; meta: ConnectomeMeta; backend: Backend }
  | { type: 'progress'; loaded: number; total: number; label: string }
  | { type: 'result'; id: number; result: SimResult }
  | { type: 'error'; message: string };
