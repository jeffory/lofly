/**
 * WebAssembly SIMD128 backend, interface-compatible with `BrainEngine`.
 *
 * Same model and parameters as the TypeScript engine; the difference is that
 * the per-step sweep runs as branchless 4-wide SIMD with threshold crossings
 * collected by bitmask. Measured on the packed MaleCNS connectome, that is
 * ~9x the TypeScript engine and crosses real time, which is what lets the
 * conductor run the brain in biological time rather than a stretched clock.
 */
import { fetchAsset } from '../lib/atlas';
import type { ConnectomeData } from './engine';
import type { SimRequest, SliceResult, SpikeEvent } from './types';

type Exports = {
  memory: WebAssembly.Memory;
  lf_alloc(bytes: number): number;
  lf_init(n: number, edges: number, viewerRows: number, dt: number,
          indptr: number, indices: number, weights: number, viewerMap: number): void;
  lf_reset(): void;
  lf_clear_channels(): void;
  lf_set_channel(neuron: number, channel: number, slot: number): void;
  lf_simulate(durationMs: number, stim: number, stimLen: number, rateHz: number,
              duty: number, channels: number, maxEvents: number): number;
  lf_events_ptr(): number;
  lf_rates_ptr(): number;
  lf_activity_ptr(): number;
  lf_total_spikes(): number;
  lf_truncated(): number;
  lf_brain_steps(): number;
};

const DEFAULT_DT = 0.2;

export class WasmBrain {
  readonly meta: ConnectomeData['meta'];
  private readonly w: Exports;
  private readonly dt: number;
  private channelKey = '';
  private stimPtr = 0;
  private stimCap = 0;

  private constructor(w: Exports, meta: ConnectomeData['meta'], dt: number) {
    this.w = w;
    this.dt = dt;
    this.meta = { ...meta, lif: { ...meta.lif, dt } };
  }

  static async create(
    baseUrl: string,
    meta: ConnectomeData['meta'],
    buffers: { indptr: ArrayBuffer; indices: ArrayBuffer; weights: ArrayBuffer; viewerMap: ArrayBuffer },
    dt = DEFAULT_DT,
  ): Promise<WasmBrain> {
    const response = await fetchAsset('wasm/lif.wasm', undefined, baseUrl);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    const w = instance.exports as unknown as Exports;

    // Copy each array in, re-reading memory.buffer every time: growing wasm
    // memory detaches the previous ArrayBuffer and any view onto it.
    const put = (source: ArrayBuffer) => {
      const pointer = w.lf_alloc(source.byteLength);
      new Uint8Array(w.memory.buffer).set(new Uint8Array(source), pointer);
      return pointer;
    };
    const indptr = put(buffers.indptr);
    const indices = put(buffers.indices);
    const weights = put(buffers.weights);
    const viewerMap = put(buffers.viewerMap);
    w.lf_init(meta.nodes, meta.edges, meta.viewerRows, dt, indptr, indices, weights, viewerMap);
    return new WasmBrain(w, meta, dt);
  }

  reset() { this.w.lf_reset(); this.channelKey = ''; }

  get brainTime() { return this.w.lf_brain_steps() * this.dt; }

  private bindChannels(request: SimRequest) {
    const key = request.channels.map(c => `${c.name}:${c.neurons.length}`).join('|');
    if (key === this.channelKey) return;
    this.w.lf_clear_channels();
    request.channels.forEach((channel, c) => {
      for (let s = 0; s < channel.neurons.length; s++) {
        this.w.lf_set_channel(channel.neurons[s], c, s);
      }
    });
    this.channelKey = key;
  }

  private writeStimulus(neurons: number[]): number {
    if (neurons.length > this.stimCap) {
      this.stimPtr = this.w.lf_alloc(Math.max(64, neurons.length) * 4);
      this.stimCap = Math.max(64, neurons.length);
    }
    new Uint32Array(this.w.memory.buffer, this.stimPtr, neurons.length).set(neurons);
    return this.stimPtr;
  }

  simulate(request: SimRequest): SliceResult {
    const wallStart = performance.now();
    this.bindChannels(request);

    // The kernel drives one population per call; flatten the request onto the
    // first non-empty group, which is all the UI ever sends.
    const group = request.stimulus.find(s => s.neurons.length && s.rateHz > 0);
    const neurons = group?.neurons ?? [];
    const pointer = neurons.length ? this.writeStimulus(neurons) : 0;

    const count = this.w.lf_simulate(
      request.durationMs, pointer, neurons.length, group?.rateHz ?? 0,
      request.dutyCycle ?? 1, request.channels.length, request.maxEvents,
    );

    const memory = this.w.memory.buffer;
    const packed = new Uint32Array(memory, this.w.lf_events_ptr(), count * 2);
    const events: SpikeEvent[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const head = packed[i * 2];
      events[i] = { channel: head >>> 16, slot: head & 0xffff, at: packed[i * 2 + 1] * this.dt };
    }

    return {
      events,
      channelRates: new Float32Array(
        new Float32Array(memory, this.w.lf_rates_ptr(), request.channels.length)),
      activity: new Float32Array(
        new Float32Array(memory, this.w.lf_activity_ptr(), this.meta.viewerRows)),
      totalSpikes: this.w.lf_total_spikes(),
      brainMs: Math.max(1, Math.round(request.durationMs / this.dt)) * this.dt,
      wallMs: performance.now() - wallStart,
      truncated: this.w.lf_truncated() !== 0,
      // The SIMD sweep visits every neuron every step, so there is no awake set
      // to report; cost per step is constant regardless of activity.
      awakeNeurons: 0,
    };
  }
}
