/**
 * Serves the LoFly build from Cloudflare Workers static assets.
 *
 * The only reason this Worker exists rather than plain asset hosting: the
 * connectome is 35 MB of `application/octet-stream`, and Cloudflare does not
 * compress that content type on the fly, so every visitor would pull 43 MB
 * instead of 15 MB.
 *
 * It deliberately does NOT negotiate on Accept-Encoding. The Workers runtime
 * rewrites that header to "br, gzip" before a handler ever sees it, so a Worker
 * cannot know what the client actually accepts; and because Cloudflare passes
 * octet-stream through untouched, guessing wrong means shipping brotli to a
 * client that cannot decode it. Verified locally: an `Accept-Encoding: identity`
 * request still received brotli.
 *
 * So the client opts in by URL instead. The app asks for `<name>.br`, and this
 * returns those bytes tagged `Content-Encoding: br` with the content type of the
 * underlying file; the browser's network stack decodes it transparently. No
 * guessing, and any client that does not ask keeps getting the plain asset.
 * `encodeBody: 'manual'` tells the runtime the body is already encoded.
 */

const CONTENT_TYPES = {
  bin: 'application/octet-stream',
  json: 'application/json',
  wasm: 'application/wasm',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

const contentTypeFor = (pathname) =>
  CONTENT_TYPES[pathname.split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('.br') || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return env.ASSETS.fetch(request);
    }

    const hit = await env.ASSETS.fetch(new Request(url, { method: 'GET' }));
    if (!hit.ok) return hit;

    const headers = new Headers(hit.headers);
    headers.set('Content-Encoding', 'br');
    headers.set('Content-Type', contentTypeFor(url.pathname.slice(0, -3)));
    // Content-Length would describe the decoded size, which we do not know.
    headers.delete('Content-Length');
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(request.method === 'HEAD' ? null : hit.body, {
      status: 200,
      headers,
      encodeBody: 'manual',
    });
  },
};
