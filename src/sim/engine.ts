/**
 * Leaky integrate-and-fire engine over the MaleCNS v1.0 connectome.
 *
 * Parameters follow Shiu et al. 2024 (Nature): every synapse contributes
 * 0.275 mV scaled by its synapse count and signed by the presynaptic
 * transmitter. Integration is exponential Euler at a 0.1 ms step, which is
 * stable here but is not bit-identical to the Brian2 reference.
 *
 * The loop only visits neurons that are away from rest. At biological firing
 * rates the awake set stays a small fraction of the network, which is what
 * makes a 164k-neuron brain tractable in a browser tab.
 *
 * Pure and environment-free so the same code runs in a Worker and under Node.
 */
import type { ConnectomeMeta, SimRequest, SliceResult, SpikeEvent } from './types';

/**
 * Below these a neuron is treated as back at rest and leaves the awake set.
 * The rest-to-threshold gap is 7 mV, so 0.05 mV of residual charge would need
 * ~140x amplification to ever matter; dropping it costs nothing measurable and
 * is the difference between ~90k awake neurons and ~10k, i.e. between 0.08x and
 * real time. Tunable because it is the single biggest accuracy/speed lever.
 */
const DEFAULT_V_EPS = 0.05;
const DEFAULT_S_EPS = 0.005;

/**
 * Integration step in ms. The packed default is Shiu et al.'s 0.1, but every
 * time constant in the model is >= 1.8 ms, so 0.2 resolves the dynamics at
 * roughly half the cost. Measured on MaleCNS under pIP10 drive: 0.1 -> 0.06x
 * real time, 0.2 -> 0.13x, 0.3 -> 0.24x, with whole-network rate drifting
 * 1.75 -> 2.07 Hz across that range. 0.2 divides the 1.8 ms delay exactly.
 */
const DEFAULT_DT = 0.2;

export type EngineOptions = {
  /**
   * Integration step in ms, overriding the packed default of 0.1. Every time
   * constant in the model is >= 1.8 ms, so 0.2 ms still resolves the dynamics
   * at half the cost. Must divide the 1.8 ms delay into whole steps.
   */
  dt?: number;
  /** mV from rest below which a neuron sleeps. */
  vEpsilon?: number;
  /** mV of synaptic drive below which a neuron sleeps. */
  sEpsilon?: number;
};

export type ConnectomeData = {
  meta: ConnectomeMeta;
  indptr: Uint32Array;
  indices: Uint32Array;
  weights: Int16Array;
  viewerMap: Int32Array;
};

export class BrainEngine {
  readonly meta: ConnectomeMeta;
  private readonly indptr: Uint32Array;
  private readonly indices: Uint32Array;
  private readonly weights: Int16Array;
  private readonly viewerMap: Int32Array;

  private readonly v: Float32Array;
  private readonly syn: Float32Array;
  private readonly refracUntil: Int32Array;
  private readonly awake: Uint8Array;
  private readonly active: Uint32Array;
  private readonly spikes: Uint16Array;
  private readonly chanOf: Int16Array;
  private readonly slotOf: Uint16Array;

  private activeCount = 0;
  private step = 0;
  private ring: number[][] = [];
  private channelKey = '';
  private random: () => number = Math.random;
  private readonly vEpsilon: number;
  private readonly sEpsilon: number;

  constructor(data: ConnectomeData, options: EngineOptions = {}) {
    const { meta, indptr, indices, weights, viewerMap } = data;
    const n = meta.nodes;
    if (indptr.length !== n + 1) throw Error('indptr length does not match node count.');
    if (indices.length !== meta.edges) throw Error('indices length does not match edge count.');
    if (weights.length !== meta.edges) throw Error('weights length does not match edge count.');
    if (viewerMap.length !== n) throw Error('viewer map length does not match node count.');

    const dt = options.dt ?? DEFAULT_DT;
    this.meta = { ...meta, lif: { ...meta.lif, dt } };
    this.indptr = indptr; this.indices = indices;
    this.weights = weights; this.viewerMap = viewerMap;
    this.v = new Float32Array(n); this.syn = new Float32Array(n);
    this.refracUntil = new Int32Array(n); this.awake = new Uint8Array(n);
    this.active = new Uint32Array(n); this.spikes = new Uint16Array(n);
    this.chanOf = new Int16Array(n); this.slotOf = new Uint16Array(n);
    this.vEpsilon = options.vEpsilon ?? DEFAULT_V_EPS;
    this.sEpsilon = options.sEpsilon ?? DEFAULT_S_EPS;
    this.reset();
  }

  /** Swap in a seeded generator to make a run reproducible. */
  setRandom(random: () => number) { this.random = random; }

  reset() {
    const { vRest, delay, dt } = this.meta.lif;
    this.v.fill(vRest); this.syn.fill(0); this.refracUntil.fill(-1);
    this.awake.fill(0); this.activeCount = 0; this.step = 0;
    this.ring = Array.from({ length: Math.round(delay / dt) + 1 }, () => []);
  }

  /** Total brain time simulated so far, in milliseconds. */
  get brainTime() { return this.step * this.meta.lif.dt; }

  private bindChannels(request: SimRequest) {
    const key = request.channels.map(c => `${c.name}:${c.neurons.length}`).join('|');
    if (key === this.channelKey) return;
    this.chanOf.fill(-1);
    request.channels.forEach((channel, c) => {
      for (let s = 0; s < channel.neurons.length; s++) {
        const neuron = channel.neurons[s];
        if (neuron >= 0 && neuron < this.chanOf.length) {
          this.chanOf[neuron] = c;
          this.slotOf[neuron] = s;
        }
      }
    });
    this.channelKey = key;
  }

  simulate(request: SimRequest): SliceResult {
    const wallStart = performance.now();
    this.bindChannels(request);

    const { indptr, indices, weights, v, syn, refracUntil, awake, active, spikes,
            chanOf, slotOf, ring } = this;
    const { vRest, vReset, vThreshold, tauM, tauSyn, refractory, delay,
            mvPerSynapse, dt } = this.meta.lif;
    const decayV = Math.exp(-dt / tauM);
    const decayS = Math.exp(-dt / tauSyn);
    const driveGain = 1 - decayV;
    const refracSteps = Math.round(refractory / dt);
    const delaySteps = Math.round(delay / dt);
    const ringLength = ring.length;
    const steps = Math.max(1, Math.round(request.durationMs / dt));
    const random = this.random;
    const vEpsilon = this.vEpsilon, sEpsilon = this.sEpsilon;
    const startStep = this.step;

    spikes.fill(0);
    const events: SpikeEvent[] = [];
    const channelRates = new Float32Array(request.channels.length);
    let totalSpikes = 0, truncated = false;
    let activeCount = this.activeCount;

    const driveSteps = Math.round(steps * Math.min(1, Math.max(0, request.dutyCycle ?? 1)));
    const stim = request.stimulus
      .filter(s => s.neurons.length && s.rateHz > 0)
      .map(s => ({ neurons: Uint32Array.from(s.neurons), p: s.rateHz * dt / 1000 }));

    const nodes = this.meta.nodes;
    // Crossover measured on this connectome: below ~1/4 awake the scattered
    // list is faster, above it the sequential sweep is.
    const dense = activeCount * 4 > nodes;

    const end = startStep + steps;
    for (let s = startStep; s < end; s++) {
      // 1. Deliver spikes that left their presynaptic neuron `delay` ms ago.
      const slot = ring[s % ringLength];
      for (let k = 0; k < slot.length; k++) {
        const i = slot[k];
        const to = indptr[i + 1];
        for (let e = indptr[i]; e < to; e++) {
          const j = indices[e];
          syn[j] += weights[e] * mvPerSynapse;
          if (!awake[j]) { awake[j] = 1; if (!dense) active[activeCount++] = j; }
        }
      }
      slot.length = 0;

      // 2. Poisson drive on the stimulated populations, for the first
      //    `dutyCycle` of the window. A driven neuron fires outright, matching
      //    the "activation" manipulation in Shiu et al.
      if (s - startStep < driveSteps) for (let g = 0; g < stim.length; g++) {
        const neurons = stim[g].neurons, p = stim[g].p;
        for (let k = 0; k < neurons.length; k++) {
          const i = neurons[k];
          if (s >= refracUntil[i] && random() < p) {
            if (!awake[i]) { awake[i] = 1; if (!dense) active[activeCount++] = i; }
            v[i] = vReset; refracUntil[i] = s + refracSteps;
            ring[(s + delaySteps) % ringLength].push(i);
            if (spikes[i] < 65535) spikes[i]++;
            totalSpikes++;
            const c = chanOf[i];
            if (c >= 0) {
              channelRates[c]++;
              if (events.length < request.maxEvents) {
                events.push({ channel: c, slot: slotOf[i], at: (s - startStep) * dt });
              } else truncated = true;
            }
          }
        }
      }

      // 3. Integrate the awake set. Chasing a scattered index list wins while
      //    the brain is quiet, but once a large fraction is awake a straight
      //    sequential sweep is cheaper than the random access, so we pick per
      //    window rather than paying list maintenance in the dense case.
      let w = 0;
      // Re-read activeCount: delivery and stimulus above may have woken more.
      const scanCount = dense ? nodes : activeCount;
      for (let k = 0; k < scanCount; k++) {
        const i = dense ? k : active[k];
        if (!awake[i]) continue;
        if (s < refracUntil[i]) { syn[i] *= decayS; if (!dense) active[w++] = i; continue; }
        const drive = syn[i];
        const potential = vRest + (v[i] - vRest) * decayV + drive * driveGain;
        syn[i] = drive * decayS;
        if (potential >= vThreshold) {
          v[i] = vReset; refracUntil[i] = s + refracSteps;
          ring[(s + delaySteps) % ringLength].push(i);
          if (spikes[i] < 65535) spikes[i]++;
          totalSpikes++;
          const c = chanOf[i];
          if (c >= 0) {
            channelRates[c]++;
            if (events.length < request.maxEvents) {
              events.push({ channel: c, slot: slotOf[i], at: (s - startStep) * dt });
            } else truncated = true;
          }
          if (!dense) active[w++] = i;
        } else {
          v[i] = potential;
          if (Math.abs(potential - vRest) < vEpsilon && Math.abs(syn[i]) < sEpsilon) {
            v[i] = vRest; syn[i] = 0; awake[i] = 0;
          }
          else if (!dense) active[w++] = i;
        }
      }
      if (!dense) activeCount = w;
    }

    if (dense) {
      // Rebuild the sparse list so a quietening network can use it next window.
      activeCount = 0;
      for (let i = 0; i < nodes; i++) if (awake[i]) active[activeCount++] = i;
    }

    this.activeCount = activeCount;
    this.step = end;

    const brainMs = steps * dt;
    // Normalize to the template's documented convention: rate / 50 Hz in [0, 1].
    const activity = new Float32Array(this.meta.viewerRows);
    const perSpike = 1000 / brainMs / 50;
    const viewerMap = this.viewerMap;
    for (let i = 0; i < viewerMap.length; i++) {
      const row = viewerMap[i];
      if (row >= 0 && spikes[i]) activity[row] = Math.min(1, spikes[i] * perSpike);
    }
    for (let c = 0; c < channelRates.length; c++) channelRates[c] *= 1000 / brainMs;

    return {
      events, channelRates, activity, totalSpikes, brainMs,
      wallMs: performance.now() - wallStart, truncated,
      awakeNeurons: activeCount,
    };
  }
}
