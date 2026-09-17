import { readFileSync } from 'node:fs';
import { buildChannels, resolveTypes, STIMULI, stimulusForBar } from '../src/sim/circuits.ts';
import { composeBar, MOODS } from '../src/audio/composer.ts';
import { KITS } from '../src/audio/kits.ts';
const dir = new URL('../public/data/connectome/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8'));
const wasm = readFileSync(new URL('../wasm/target/wasm32-unknown-unknown/release/lif_wasm.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const w = instance.exports;
const put = b => { const p = w.lf_alloc(b.length); new Uint8Array(w.memory.buffer).set(b, p); return p; };
const a=put(readFileSync(new URL('indptr.bin',dir))),b2=put(readFileSync(new URL('indices.bin',dir)));
const c2=put(readFileSync(new URL('weights.bin',dir))),d2=put(readFileSync(new URL('viewer_map.bin',dir)));
w.lf_init(meta.nodes, meta.edges, meta.viewerRows, 0.2, a, b2, c2, d2);
const channels = buildChannels(meta);
const sizes = new Map(channels.map(c=>[c.name,c.neurons.length]));
w.lf_clear_channels(); channels.forEach((ch,ci)=>ch.neurons.forEach((n,s)=>w.lf_set_channel(n,ci,s)));
const stim = new Map();
for (const s of STIMULI){const i=resolveTypes(meta,s.types);const p=w.lf_alloc(i.length*4);
  new Uint32Array(w.memory.buffer,p,i.length).set(i);stim.set(s.key,[p,i.length]);}
const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
console.log('key            distinct pitch classes played');
for (const mood of MOODS) {
  w.lf_reset();
  const pcs = new Set();
  for (let bar=0;bar<8;bar++){
    const [p,len]=stim.get(stimulusForBar(bar,3));
    const n=w.lf_simulate(400,p,len,150,0.35,channels.length,40000);
    const packed=new Uint32Array(w.memory.buffer,w.lf_events_ptr(),n*2);
    const byChannel=new Map();
    for(let i=0;i<n;i++){const nm=channels[packed[i*2]>>>16]?.name;if(!nm)continue;
      const e={slot:packed[i*2]&0xffff,at:packed[i*2+1]*0.2};
      const l=byChannel.get(nm);if(l)l.push(e);else byChannel.set(nm,[e]);}
    for (const nt of composeBar({byChannel,channelSize:sizes,brainMs:400,barSeconds:2.5,bar,
      intensity:1,kit:KITS[0],scale:mood.scale,progression:mood.progression}))
      if (nt.midi) pcs.add(nt.midi % 12);
  }
  console.log(`${mood.key.padEnd(14)} ${[...pcs].sort((x,y)=>x-y).map(x=>N[x]).join(' ')}`);
}
