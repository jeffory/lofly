/// <reference lib="webworker" />
/**
 * Worker shell: fetches the packed connectome and runs it off the main thread.
 *
 * Prefers the WebAssembly SIMD kernel, which is ~9x the TypeScript engine and
 * runs above real time. Falls back to the TypeScript engine when SIMD is
 * unavailable or the module fails to load, so the app still works everywhere —
 * just on a stretched clock.
 */
import { fetchAsset } from '../lib/atlas';
import { BrainEngine, type ConnectomeData } from './engine';
import { WasmBrain } from './wasm-engine';
import type { ConnectomeMeta, SimRequest, SimResult, SliceResult, WorkerIn, WorkerOut } from './types';

const post = (message: WorkerOut, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

type Engine = { meta: ConnectomeMeta; reset(): void; simulate(r: SimRequest): SliceResult };
let engine: Engine | null = null;

/**
 * Run one bar as a series of sub-windows.
 *
 * Composition needs the whole bar at once — the top-K density rule ranks grid
 * cells against each other — but the brain view needs to change more often than
 * once every 2.5 seconds. So the window is simulated in slices: events are
 * merged back into one bar-length list, while each slice keeps its own activity
 * snapshot for the view to play back in time with the audio.
 *
 * The burst envelope is preserved across the split. Passing the same dutyCycle
 * to each slice would fire one burst per slice instead of one per bar, so the
 * drive is spread: full in the slices the burst covers, partial in the one it
 * ends in, silent after.
 */
function simulateBar(source: Engine, request: SimRequest): SimResult {
  const count = Math.max(1, Math.round(request.activityFrames ?? 1));
  if (count === 1) {
    const single = source.simulate(request);
    const frames = new Uint8Array(single.activity.length);
    for (let i = 0; i < frames.length; i++) frames[i] = Math.round(single.activity[i] * 255);
    return { ...single, frames, frameCount: 1 };
  }

  const sliceMs = request.durationMs / count;
  const duty = request.dutyCycle ?? 1;
  const rows = source.meta.viewerRows;
  const frames = new Uint8Array(rows * count);
  const events: SimResult['events'] = [];
  let totalSpikes = 0, wallMs = 0, brainMs = 0, truncated = false, awake = 0;
  let rates: Float32Array | null = null;

  for (let i = 0; i < count; i++) {
    const slice = source.simulate({
      ...request,
      durationMs: sliceMs,
      // Fraction of THIS slice that still falls inside the bar's burst.
      dutyCycle: Math.min(1, Math.max(0, duty * count - i)),
      maxEvents: request.maxEvents,
    });
    const offset = i * sliceMs;
    for (const e of slice.events) events.push({ ...e, at: e.at + offset });
    totalSpikes += slice.totalSpikes;
    wallMs += slice.wallMs;
    brainMs += slice.brainMs;
    truncated ||= slice.truncated;
    awake = slice.awakeNeurons;
    if (!rates) rates = new Float32Array(slice.channelRates.length);
    for (let c = 0; c < rates.length; c++) rates[c] += slice.channelRates[c] / count;
    const base = i * rows;
    for (let r = 0; r < rows; r++) frames[base + r] = Math.round(slice.activity[r] * 255);
  }

  // The bar's own activity is the last slice, which is what the view settles on.
  const activity = new Float32Array(rows);
  const last = (count - 1) * rows;
  for (let r = 0; r < rows; r++) activity[r] = frames[last + r] / 255;

  return {
    events, channelRates: rates ?? new Float32Array(0), activity, frames, frameCount: count,
    totalSpikes, brainMs, wallMs, truncated, awakeNeurons: awake,
  };
}

/** Minimal module that uses v128, to check the host really supports SIMD. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);
const hasSimd = () => { try { return WebAssembly.validate(SIMD_PROBE); } catch { return false; } };

async function load(baseUrl: string) {
  const grab = async (name: string, label: string) => {
    post({ type: 'progress', loaded: 0, total: 0, label });
    const response = await fetchAsset(`data/connectome/${name}`, undefined, baseUrl)
      .catch(() => { throw Error(`missing ${name} — run scripts/pack-connectome.py`); });
    return response.arrayBuffer();
  };
  const meta = JSON.parse(
    new TextDecoder().decode(await grab('meta.json', 'metadata')),
  ) as ConnectomeMeta;
  const indptr = await grab('indptr.bin', 'row offsets');
  const indices = await grab('indices.bin', 'synaptic targets');
  const weights = await grab('weights.bin', 'synaptic weights');
  const viewerMap = await grab('viewer_map.bin', 'atlas mapping');

  if (hasSimd()) {
    try {
      post({ type: 'progress', loaded: 0, total: 0, label: 'SIMD kernel' });
      engine = await WasmBrain.create(
        baseUrl, meta, { indptr, indices, weights, viewerMap });
      post({ type: 'ready', meta: engine.meta, backend: 'wasm-simd' });
      return;
    } catch (error) {
      // Fall through to the portable engine rather than failing the load.
      post({ type: 'progress', loaded: 0, total: 0,
             label: `SIMD unavailable (${error instanceof Error ? error.message : error}), using TypeScript engine` });
    }
  }
  const data: ConnectomeData = {
    meta,
    indptr: new Uint32Array(indptr),
    indices: new Uint32Array(indices),
    weights: new Int16Array(weights),
    viewerMap: new Int32Array(viewerMap),
  };
  engine = new BrainEngine(data);
  post({ type: 'ready', meta: engine.meta, backend: 'typescript' });
}

self.onmessage = async (event: MessageEvent<WorkerIn>) => {
  const message = event.data;
  try {
    if (message.type === 'init') await load(message.baseUrl);
    else if (message.type === 'reset') engine?.reset();
    else if (message.type === 'simulate') {
      if (!engine) throw Error('connectome not loaded');
      const result = simulateBar(engine, message.request);
      post({ type: 'result', id: message.id, result },
           [result.activity.buffer, result.channelRates.buffer, result.frames.buffer]);
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
