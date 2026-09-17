/** Promise wrapper around the simulation worker. */
import type { Backend, ConnectomeMeta, SimRequest, SimResult, WorkerOut } from './types';

export class BrainClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (result: SimResult) => void>();
  private ready: Promise<{ meta: ConnectomeMeta; backend: Backend }>;

  constructor(baseUrl: string, onProgress?: (label: string) => void) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise<{ meta: ConnectomeMeta; backend: Backend }>((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === 'ready') resolve({ meta: message.meta, backend: message.backend });
        else if (message.type === 'progress') onProgress?.(message.label);
        else if (message.type === 'error') {
          reject(Error(message.message));
          this.pending.forEach(r => r({
            events: [], channelRates: new Float32Array(0), activity: new Float32Array(0),
            totalSpikes: 0, brainMs: 0, wallMs: 0, truncated: false, awakeNeurons: 0,
            frames: new Uint8Array(0), frameCount: 0, sliceRates: new Float32Array(0),
          }));
          this.pending.clear();
        } else if (message.type === 'result') {
          this.pending.get(message.id)?.(message.result);
          this.pending.delete(message.id);
        }
      };
      this.worker.onerror = e => reject(Error(e.message || 'worker failed'));
    });
    this.worker.postMessage({ type: 'init', baseUrl });
  }

  whenReady() { return this.ready; }

  simulate(request: SimRequest): Promise<SimResult> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: 'simulate', id, request });
    });
  }

  reset() { this.worker.postMessage({ type: 'reset' }); }
  dispose() { this.worker.terminate(); this.pending.clear(); }
}
