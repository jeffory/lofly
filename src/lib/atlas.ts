export type Atlas = { positions: Float32Array; ids: Uint32Array; groups: Uint8Array; visibleIds: Set<number> };
export const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

/**
 * Absolute asset base, for use off the main thread.
 *
 * The build uses a relative `base`, so BASE_URL is "./". On the main thread
 * that resolves against the page, which is what we want. Inside a bundled Web
 * Worker it resolves against the worker script instead — which lives in
 * /assets/ — and every data fetch silently becomes /assets/data/... Dev never
 * shows this because BASE_URL is "/" there. Resolve it once on the main thread
 * and hand the worker an absolute URL.
 */
export const assetBase = () => new URL(import.meta.env.BASE_URL, location.href).href;

/**
 * Fetch a static asset, preferring the pre-compressed copy.
 *
 * Cloudflare will not compress `application/octet-stream` on the fly, and a
 * Worker cannot negotiate on Accept-Encoding because the runtime rewrites it.
 * So the client opts in by URL: ask for `<name>.br` and let the browser decode
 * it. Falls back to the plain asset, which is what a dev server serves.
 */
export async function fetchAsset(
  path: string, signal?: AbortSignal, base?: string,
): Promise<Response> {
  const plain = base ? new URL(path, base).href : asset(path);
  try {
    const compressed = await fetch(`${plain}.br`, { signal });
    if (compressed.ok) return compressed;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const response = await fetch(plain, { signal });
  if (!response.ok) throw Error(`Asset could not load: ${path}`);
  return response;
}
export async function loadAtlas(signal: AbortSignal): Promise<Atlas> {
  const read = (path: string) => fetchAsset(`data/brain-atlas/${path}`, signal);
  const manifest = await (await read('manifest.json')).json();
  const buffers = await Promise.all(['positions.bin', 'ids.bin', 'groups.bin'].map(async name => (await read(name)).arrayBuffer()));
  const positions = new Float32Array(buffers[0]), ids = new Uint32Array(buffers[1]), groups = new Uint8Array(buffers[2]);
  if (positions.length !== manifest.count * 3 || ids.length !== manifest.count || groups.length !== manifest.count) throw Error('Atlas file lengths do not match the manifest.');
  const visibleIds = new Set(Array.from(ids).filter((_, index) => groups[index] < 3));
  if (visibleIds.size !== manifest.brainCount) throw Error('Brain selection does not match the manifest.');
  return { positions, ids, groups, visibleIds };
}
