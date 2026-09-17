#!/usr/bin/env node
/**
 * Pre-compress the binary assets for Cloudflare Workers.
 *
 * Cloudflare compresses responses on the fly only for content types it
 * considers compressible, and `application/octet-stream` is not one of them.
 * The connectome is 35 MB of octet-stream, so without this every visitor pulls
 * the full 43 MB instead of 15 MB. Cloudflare passes through a body that
 * already carries Content-Encoding, so we ship a .br next to each asset and let
 * worker/index.js hand it out.
 *
 * Brotli only, deliberately: Cloudflare terminates TLS, so Accept-Encoding is
 * negotiated directly with the browser and no intermediary can strip `br`.
 * Every browser that can run the WASM SIMD kernel also supports brotli, and the
 * uncompressed original stays in place for anything that does not.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const root = new URL('../dist/', import.meta.url).pathname;
const DIRS = ['data', 'wasm'];
// Below this, the header overhead and extra file are not worth it.
const MIN_BYTES = 2048;

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

let rawTotal = 0, brTotal = 0, count = 0;
for (const base of DIRS) {
  let files;
  try { files = walk(join(root, base)); } catch { continue; }
  for (const file of files) {
    if (file.endsWith('.br')) continue;
    const size = statSync(file).size;
    if (size < MIN_BYTES) continue;
    const raw = readFileSync(file);
    const compressed = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    writeFileSync(file + '.br', compressed);
    rawTotal += size; brTotal += compressed.length; count++;
    const name = relative(root, file);
    console.log(`  ${name.padEnd(36)} ${(size / 1048576).toFixed(2).padStart(7)} MB -> ${(compressed.length / 1048576).toFixed(2).padStart(7)} MB`);
  }
}
console.log(`\n${count} files pre-compressed: ${(rawTotal / 1048576).toFixed(2)} MB -> ${(brTotal / 1048576).toFixed(2)} MB brotli`);

// The free plan refuses any single asset above 25 MiB.
const LIMIT = 25 * 1024 * 1024;
const oversize = walk(root).filter(f => statSync(f).size > LIMIT);
if (oversize.length) {
  console.error('\nERROR: over the 25 MiB per-file limit:');
  for (const f of oversize) console.error(`  ${relative(root, f)} ${(statSync(f).size / 1048576).toFixed(2)} MB`);
  process.exit(1);
}
const largest = walk(root).map(f => [f, statSync(f).size]).sort((a, b) => b[1] - a[1])[0];
console.log(`largest asset: ${relative(root, largest[0])} at ${(largest[1] / 1048576).toFixed(2)} MB ` +
            `(${(100 * largest[1] / LIMIT).toFixed(0)}% of the 25 MiB limit)`);
