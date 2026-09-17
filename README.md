<p align="center">
  <img src="assets/preview.svg" alt="fly-connectome-template: real MaleCNS anatomy and a starter for your own experiment" width="760">
</p>

<p align="center">
  A browser workbench for building your own fly-connectome experiments.
  Real anatomy, a replaceable environment, and model outputs mapped by neuron ID.
</p>

<p align="center">
  <a href="https://github.com/cobanov/fly-connectome-template/actions/workflows/ci.yml"><img alt="build" src="https://github.com/cobanov/fly-connectome-template/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%E2%89%A522.18-527fa3?labelColor=151b22">
  <img alt="anatomy" src="https://img.shields.io/badge/anatomy-MaleCNS_v1.0-527fa3?labelColor=151b22">
  <a href="LICENSE"><img alt="licence: attribution required" src="https://img.shields.io/badge/licence-attribution_required-527fa3?labelColor=151b22"></a>
</p>

---

Start with a fly body and measured brain coordinates already on screen. Replace
the environment, connect your own model and inspect its outputs against the
same MaleCNS neuron IDs. Training and inference stay in your own stack; the
browser handles the experiment view.

- **Real anatomy.** 124,289 classified brain soma positions from MaleCNS v1.0,
  rendered without stretching the axes, plus the anatomical Flybody mesh.
- **Replaceable parts.** Environment on the left, brain above the body on the
  right. Each is a separate React component; the layout stacks on mobile.
- **An explicit model boundary.** JSON replay with timestamps, body IDs,
  normalized values and declared provenance. No neural activity is invented
  when no model is connected.
- **A small web stack.** React, TypeScript, Three.js and Vite. No required
  account, backend, database or hosting provider.

The code is **source-available with mandatory attribution** in your web UI and
repository README. Your own models and weights can remain private. See
[Licence](#licence) before reusing.

## Start

[Use this template][generate] to create your repository, then clone it.
With Node.js **22.18+**:

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. The example stimulus starts automatically;
the brain initially shows anatomy only. **Load synthetic example**, then
**Play**, demonstrates the output pipeline with clearly labeled test values.
**Load model JSON** reads your own replay locally in the browser.

## LoFly: the song circuit as an instrument

> **This is a modified version of [fly-connectome-template][repo] by
> [Mert Cobanov][author].** The original is a viewer: real anatomy, a replaceable
> environment, and a JSON replay format. Everything below — the spiking
> simulation, the WebAssembly kernel, the audio layer, the wing rigging and the
> Cloudflare Worker — is added on top, and the bugs in it are mine, not the
> template's. Required by the template licence, which asks that modified
> versions identify themselves as such.

This fork adds a whole-brain spiking simulation and a Web Audio output stage, so
the connectome plays music rather than replaying a file.

```sh
# one-off: build the browser connectome from the Janelia feather tables
python scripts/pack-connectome.py /path/to/feather-dir --threshold 5
npm run build:wasm      # optional; a prebuilt lif.wasm is committed
npm run dev             # or dev:lan to serve on the local network
```

`scripts/fetch-source-data.sh` downloads the three MaleCNS tables the packer
needs (1.06 GB total, from [the Janelia
bucket](https://male-cns.janelia.org/download/)). They are deliberately not kept
in the repo: they are only needed to re-pack at a different threshold, and a
published versioned dataset is cheaper to re-fetch than to store. The packer
writes ~38 MB of CSR binaries to
`public/data/connectome/` (about 14 MB gzipped over the wire): 163,718 neurons
and 6,093,442 synapses at a 5-synapse threshold, signed by predicted
transmitter, with 124,259 of the 124,289 drawn somata wired.

**Why these neurons.** MaleCNS is a *male* connectome, and male flies sing by
vibrating a wing. pIP10 is the descending command neuron that starts courtship
song; dPR1, dMS9 and TN1a are the thoracic song circuit it drives; the b, i, hg
and tp motor neurons steer the wing and the DLM/DVM motor neurons power the
wingbeat. Those six populations are the audio channels — the fly's own output
bus, not a sonification bolted onto unrelated cells.

**How a bar is made.** Brain time and musical time are decoupled: each bar is
driven by a window of brain time (400 ms by default) and audio is scheduled a
bar ahead. Spikes are histogrammed onto a 16-cell grid and only the busiest
cells become notes, with pitch set by which neuron in the population fired. The
grid, key and chord progression are imposed; the rhythm and melodic contour are
the connectome's. Windows much beyond 400 ms start to homogenise — the bass
falls from five distinct pitches to three — for the same saturation reason that
burst drive exists.

**The kernel.** `wasm/` is a Rust crate compiled to WebAssembly SIMD128
(`npm run build:wasm`, needs `rustup target add wasm32-unknown-unknown`). The
worker prefers it and falls back to `src/sim/engine.ts` when SIMD is
unavailable, so the app still runs everywhere. Measured on this connectome:

| Kernel | Real-time factor |
| --- | --- |
| TypeScript engine | 0.13x |
| Naive C port (reference) | 0.21x |
| **WASM SIMD128** | **1.19x** |
| Native AVX2, 1 thread (reference) | 4.79x |

Nearly all of that gap is vectorisation rather than nativeness, which is why the
kernel is worth having in the browser at all. Two things buy it: the sweep is
branchless and visits every neuron unconditionally (a neuron at rest is a fixed
point of the update, so touching it is wasted but never wrong), and it is
unrolled 4x because the per-block dependency chain is latency-bound rather than
throughput-bound. Cost per step is therefore constant regardless of how active
the brain is, which is what real-time audio scheduling wants.

**The body is driven too.** The flybody mesh ships with only three pivots —
the trunk and the two front legs — so the wings arrive welded into the static
body group. They split out cleanly: the membrane is its own part, and the vein
geometry separates from the legs at y = -0.01 with nothing in between. Stroke
amplitude follows the power muscles (DLMn/DVMn) and tilt follows the balance of
the steering muscles, which are the same spike trains driving the hat, perc and
pluck voices — so the fly beats in time with its own drums. The flap *rate* is a
legible stand-in: a real fly beats at ~200 Hz, faster than any display. It is a
kinematic mapping, not physics.

**Pitch is resolved against the key, not the voice.** Two bugs here were audible
as a persistent eeriness, and both are easy to reintroduce. Transposing the
scale by the chord root plays the parallel minor over every major chord (Ab
against A on the F); and building the pitch ladder from a voice's own `low` note
puts each voice in its own key — the pluck, at low = E4, played Em over Am. A
voice's `low` and `span` are a register window and nothing more.

**Health reporting.** The simulation, the renderer and the audio clock degrade
independently and want different remedies, so `src/lib/health.ts` reports them
separately and every message carries its fix:

- *Simulation over budget* is the only failure that damages output. Above 85% of
  the bar for three bars running, the conductor cuts brain-time-per-bar itself
  and says so — glitched audio is worse than a shorter window. It never raises
  automatically, which would oscillate against a load that is already marginal.
- *Renderer stalling* is measured by frame rate and `long-animation-frame`.
  Audio is scheduled a bar ahead, so this is cosmetic, and the message says so.
  `WEBGL_debug_renderer_info` also catches a software rasteriser (SwiftShader,
  llvmpipe) up front, which is reported instead of the low frame rate it causes.
- *A lost WebGL context* leaves a permanently black canvas unless handled; both
  scenes now block the default and recover on restore.

**Panels are flex columns, not stacks of absolutely positioned strips.** The
template positioned each panel's header, body and caption absolutely, which is
fine when the body is a fixed-size canvas and falls apart as soon as anything in
it has variable height — three separate overlap bugs here traced to exactly
that. Each panel is now `display:flex; flex-direction:column`, the header and
caption are ordinary flex items, and the body takes `flex:1; min-height:0`.

Three uses of `position:absolute` survive, all deliberate: the canvas itself, so
its size can never feed back into the flex item that sizes it, and the two
overlays that genuinely float on top of the canvas. Those overlays now live
*inside* the viewport element rather than beside it — as siblings they anchored
to the panel and had to be offset past the header and caption by hand, which
broke whenever either changed height.

**Poking the fly.** Six one-shot sensory events fire on top of whatever is
driving, and four behavioural readouts show what the fly did rather than only
what it sounded like. The one to listen for is *Threat*: LPLC2 is the looming
detector, and stimulating it takes the giant fibre (DNp01) from silence to
~50 Hz while halving the song circuit — pulse 76 to 27 Hz, TN1a 56 to 12.
Escape overriding courtship is what a real fly does, and nothing here imposes
it; it falls out of the wiring.

Interactivity cost a scheduling change. Audio is scheduled ahead, and that
lookahead is exactly what a poke has to wait out: at 1.5 bars a click could miss
two bars and take ~8 seconds to be heard. A bar costs about 35% of its own
length to simulate, so the lookahead is now 1.05 bars and a poke is held for two
bars — measured latency 1.5 s, and still no underruns.

Not everything survived the test. *Taste* is in the list but barely moves the
proboscis motor neurons, because MaleCNS v1.0 does not carry the sugar-to-MN9
feeding pathway that the FlyWire feeding demos use; `BM_Taste` is a
mechanosensory bristle population, not a sugar chemoreceptor. It is kept and
labelled honestly rather than quietly dropped.

**Keys have to differ in pitch content, not just in name.** The first set
offered A minor, C major and D dorian — which are the same seven white notes
seen from three tonics. With no cadence to establish a tonic, switching between
them reordered the chords and changed almost nothing an ear could catch. The
five on offer now each use a different pitch-class set, either through
accidentals or a characteristic degree (the phrygian b2, the lydian #4), and
every chord is diatonic to its own scale so none of them reintroduces the
parallel-minor clash described below.

**Which circuits are worth driving.** Seven, chosen by measuring rather than by
reputation: each earns its place by driving a measurably different mix into the
voices (pIP10 puts 39 Hz into the lead and 26 into the drums; the cVA pheromone
channel inverts that at 5 and 146). Seven at three bars each is a 21-bar cycle
against an 8-bar progression, so the pair realigns only every 168 bars. Against
the previous four, repetition falls at every scale — most at a 12-bar lag, where
a four-stimulus cycle used to land on itself exactly:

| cycle | lag 4 | lag 8 | lag 12 |
| --- | --- | --- | --- |
| 4 stimuli | 0.41 / 0.48 | 0.42 / 0.57 | 0.62 / 0.75 |
| 7 stimuli | 0.31 / 0.44 | 0.33 / 0.52 | 0.38 / 0.53 |

Two circuits that look obvious on paper were tested and rejected, both because
this model is connectome-constrained but not dynamics-tuned:

- *EPG*, the heading compass, does not form a bump here — 100% of the ring fires
  rather than a localised subset, so there is no free arpeggiator in it. It is
  still useful as a stimulus, just not as a sequencer.
- *Kenyon cells* are not sparse here: 62% fire per bar against roughly 5% in a
  living fly, because the model has no APL feedback inhibition to enforce it. As
  a voice they would be a wash rather than a melody.

`DNp01` (the giant fibre) and the olfactory receptor neurons are silent as
outputs, which is correct — they are the top of the hierarchy, so they belong on
the stimulus side.

**The brain view animates on the audio clock.** Composition needs a whole bar
at once, since the top-K density rule ranks grid cells against each other — but
updating the view once per bar left the points sitting at a fixed value for two
of every two and a half seconds, which reads as a static cloud that happens to
rotate. So the bar is simulated in eight slices: events merge back into one
bar-length list for the composer, while each slice keeps its own activity
snapshot. Those snapshots cannot simply be drawn as they arrive — the whole bar
is computed in one burst while the previous bar plays, so all eight would land
in the same millisecond. They are queued and released against
`AudioContext.currentTime`, the same clock the notes are scheduled on.

Two details that matter: the burst envelope is spread across the slices rather
than repeated in each (passing the same `dutyCycle` to every slice would fire
eight bursts per bar instead of one), and snapshots are bytes rather than floats
because this is per-bar traffic and the shader only needs 8 bits of brightness.

**Instrument kits.** `src/audio/kits.ts` defines each style as a synth patch
*plus* how the voice plays — register, density and grid. A style is not only a
timbre: a bell firing sixteen times a bar sounds like a broken clock, so Glass
is sparse and high (22 notes/bar) where Neon is busy and bright (45). What a kit
cannot change is which neurons feed which voice; that mapping is measured, and
`VOICE_CHANNELS` keeps it fixed.

**OS media controls.** Web Audio alone does not create a media session —
browsers key that off a media *element* — so `src/audio/media-session.ts` runs a
silent looping `<audio>` purely to anchor one. The real sound still goes out
through the AudioContext untouched, so nothing is added to the latency path.
Media keys, the lock screen and the tab's pause button all work; next/previous
step through the kits, and the metadata names the circuit currently driving.

**Two findings that shaped the design**, both reproducible with
`scripts/structure.mts` and `scripts/compose-check.mts`:

- *Sustained drive is musically dead.* Under constant stimulation the network
  saturates and per-bar spike distributions go uniform (wing motor neurons fall
  to CV 0.04). Driving in bursts and letting the circuit ring out restores
  structure, so stimulus is applied for a fraction of each bar (`dutyCycle`).
- *Population size decides the part.* Two-cell types stay sparse and varied
  (pIP10 CV 1.55, b1 MN CV 2.84) and carry rhythm and melody; the 24
  power-muscle neurons fire in nearly every grid cell (CV 0.2), which is what a
  hi-hat wants. Voices are assigned on that measurement.

Simulation parameters follow
[Shiu et al. 2024](https://www.nature.com/articles/s41586-024-07763-9): -52 mV
rest, -45 mV threshold, 20 ms membrane and 5 ms synaptic time constants, 2.2 ms
refractory, 1.8 ms delay and 0.275 mV per synapse signed by transmitter.
Integration is exponential Euler at 0.2 ms, which is not bit-identical to the
Brian2 reference. This is simulated activity, not a recording from a living fly.

## Make it yours

| File | Replace or connect |
| --- | --- |
| `src/components/Environment.tsx` | Your game, video or sensory scene |
| `src/components/BrainScene.tsx` | Your model's `ActivityFrame`, keyed by MaleCNS body ID |
| `src/components/FlyScene.tsx` | Your motor decoder or physics adapter |
| `src/App.tsx` | Experiment clock, controls and replay/live adapter |
| `src/style.css` | Your layout and visual design |

The [model integration guide](docs/MODEL-INTEGRATION.md) covers the JSON format,
Python-side data layout and live adapters. The validator rejects incompatible
datasets, unknown IDs, duplicate IDs, invalid values and unordered timestamps.
It validates the format, not the scientific truth of a model's output.

## What the anatomy means

These are **cell-body positions**, not neurite branches or a synaptic graph.
The source is the adult male MaleCNS dataset, not female FlyWire. Of 140,024
bundled measured positions, the viewer draws 124,289 classified optic, central
and descending somata; it omits VNC-associated and unclassified cells.
Missing positions are never generated.

Native 8 nm coordinates are centered, rigidly rotated and uniformly scaled.
**XY view** resets the projection; **Orbit** controls rotation. Point size and
color are display choices. Flybody is a surface mesh here, not a physics
simulation. No trained policy, neural simulator or biological firing data is
included.

The [atlas manifest](public/data/brain-atlas/manifest.json) records source,
filters and hashes. The [data notice](public/data/brain-atlas/NOTICE.md)
includes the command to reproduce or audit the export. The header image is a
sample of those same measured coordinates.

## Deploying to Cloudflare Workers

```sh
npm run deploy        # build, pre-compress, wrangler deploy
npm run preview:cf    # the same, served by the local Workers runtime
```

A first visit transfers **15.2 MB**, measured against the real runtime. That
takes a Worker rather than plain asset hosting, for one reason: the connectome
is 35 MB of `application/octet-stream`, and Cloudflare does not compress that
content type on the fly. Left alone, every visitor pulls 43 MB.

`scripts/precompress.mjs` writes a brotli `.br` beside each asset and fails the
build if any file exceeds Cloudflare's 25 MiB per-file limit — `indices.bin` is
currently at 93% of it, so a lower synapse threshold will trip that guard.

**The Worker does not negotiate on Accept-Encoding, deliberately.** The runtime
rewrites that header to `"br, gzip"` before a handler sees it, so a Worker
cannot know what the client accepts; and because Cloudflare passes octet-stream
through untouched, guessing wrong means shipping brotli to a client that cannot
decode it. Instead the client opts in by URL: `fetchAsset` asks for `<name>.br`
and falls back to the plain asset, and the Worker tags only `.br` paths with
`Content-Encoding`. A client that does not ask always gets the plain file.

Two things to know when working on this:

- `npm run build` empties `dist/`, so `precompress` must run after it and
  `wrangler dev` must be restarted afterwards or it serves a stale manifest.
- The build uses a relative `base`, so `BASE_URL` is `"./"`. That resolves
  against the page on the main thread but against the *worker script* inside a
  bundled Web Worker, turning every data fetch into `/assets/data/...`. Pass
  `assetBase()` across the worker boundary; dev never shows this because
  `BASE_URL` is `/` there.

## Verify and deploy

```sh
npm test                # model-output contract and the bundled fixture
npm run check:assets    # anatomical asset hashes
npm run build           # type check and static build
npm run preview         # inspect dist/ locally
```

GitHub Actions runs the same checks. Serve `dist/` on any static host; assets
also work under a subpath. On Cloudflare Pages, use build command
`npm run build` and output directory `dist`. GPU training and inference run
separately and provide replay files or live outputs to the frontend.

## Licence

**[Cobanov Template Attribution License 1.0](LICENSE)** is a custom,
attribution-required source-available license, not an OSI-approved license.
Keep this linked credit in both your web UI and repository README:

Built with [fly-connectome-template][repo] by [Mert Cobanov][author].

The ready-made UI credit is `src/components/Attribution.tsx`. You may restyle it
or move it to an About/Credits view reachable in one click from the main UI;
you may not hide it or remove its links. [ATTRIBUTION.md](ATTRIBUTION.md) explains
the requirements. Derived versions must identify that they were modified.
Your own models, weights and modifications do not have to be published.

MaleCNS data remains **CC BY 4.0**, credited to FlyEM / HHMI Janelia, University
of Cambridge, MRC Laboratory of Molecular Biology and Google Research.
Flybody remains **Apache-2.0**. Their licenses are separate from the template's;
see [third-party notices](THIRD_PARTY_NOTICES.md).

[repo]: https://github.com/cobanov/fly-connectome-template
[author]: https://github.com/cobanov
[generate]: https://github.com/new?template_name=fly-connectome-template&template_owner=cobanov
