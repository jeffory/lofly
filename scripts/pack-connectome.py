#!/usr/bin/env python3
"""Pack MaleCNS v1.0 into a browser-loadable CSR spiking network.

Reads the Janelia flat-connectome feather tables plus the template's own
brain-atlas binaries, and writes public/data/connectome/.

Rows are presynaptic (spike source), columns postsynaptic (spike target),
so one spike reads one contiguous CSR row.

Usage: pack-connectome.py <feather-dir> [--threshold 5]
"""
import argparse, json, sys
from pathlib import Path
import numpy as np
import pyarrow.feather as feather

# Drosophila fast-transmission signs. Glutamate is inhibitory here (GluCl-alpha)
# and histamine is inhibitory (HisCl, photoreceptor output), which is the
# convention Shiu et al. 2024 use. Monoamines have no fast ionotropic effect in
# this model, so their edges are dropped rather than silently made excitatory.
SIGN = {"acetylcholine": 1, "glutamate": -1, "gaba": -1, "histamine": -1,
        "dopamine": 0, "octopamine": 0, "serotonin": 0, "unclear": 0}

SUPERCLASS_ORDER = ["optic", "central", "descending", "vnc", "other"]
GROUP_OF = {
    **{k: 0 for k in ["ol_intrinsic","ol_sensory","visual_projection","visual_centrifugal","visual_projection_tbc"]},
    **{k: 1 for k in ["cb_intrinsic","cb_sensory","cb_motor","cb_endocrine","cb_sensory_tbc","cb_efferent"]},
    **{k: 2 for k in ["descending_neuron","descending_neuron_tbc","sensory_descending","efferent_descending"]},
    **{k: 3 for k in ["vnc_intrinsic","vnc_sensory","vnc_motor","vnc_efferent","vnc_tbc","vnc_sensory_tbc",
                      "vnc_endocrine","ascending_neuron","sensory_ascending","sensory_ascending_tbc","efferent_ascending"]},
}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("feather_dir", type=Path)
    ap.add_argument("--threshold", type=int, default=5,
                    help="minimum synapse count per edge (Shiu et al. use 5)")
    root = Path(__file__).resolve().parent.parent
    ap.add_argument("--out", type=Path, default=root / "public/data/connectome")
    ap.add_argument("--atlas", type=Path, default=root / "public/data/brain-atlas",
                    help="brain-atlas directory; independent of --out so a pack "
                         "can be written anywhere")
    args = ap.parse_args()

    src = args.feather_dir
    atlas = args.atlas
    args.out.mkdir(parents=True, exist_ok=True)

    print("reading annotations...")
    ann = feather.read_table(src / "body-annotations-male-cns-v1.0-minconf-0.5.feather",
                             columns=["bodyId", "superclass", "type", "status"]).to_pydict()
    traced = {b for b, s in zip(ann["bodyId"], ann["status"]) if s == "Traced"}
    superclass_of = dict(zip(ann["bodyId"], ann["superclass"]))
    type_of = dict(zip(ann["bodyId"], ann["type"]))
    print(f"  {len(traced):,} traced bodies")

    print("reading neurotransmitters...")
    nt = feather.read_table(src / "body-neurotransmitters-male-cns-v1.0.feather",
                            columns=["body", "consensus_nt"]).to_pydict()
    sign_of = {b: SIGN.get(n, 0) for b, n in zip(nt["body"], nt["consensus_nt"]) if n}

    print("reading weights (1.1 GB, takes a minute)...")
    w = feather.read_table(src / "connectome-weights-male-cns-v1.0-minconf-0.5.feather")
    pre = w.column("body_pre").to_numpy().astype(np.int64)
    post = w.column("body_post").to_numpy().astype(np.int64)
    cnt = w.column("weight").to_numpy()
    del w
    print(f"  {len(pre):,} raw segment-to-segment edges")

    keep = np.zeros(max(pre.max(), post.max()) + 1, dtype=bool)
    keep[list(traced)] = True
    m = keep[pre] & keep[post] & (cnt >= args.threshold)
    pre, post, cnt = pre[m], post[m], cnt[m]
    print(f"  {len(pre):,} traced-to-traced edges at >={args.threshold} synapses")

    # Sign by the PREsynaptic neuron's transmitter, then drop modulatory edges.
    signs = np.array([sign_of.get(int(b), 0) for b in pre], dtype=np.int8)
    nz = signs != 0
    pre, post, cnt, signs = pre[nz], post[nz], cnt[nz], signs[nz]
    print(f"  {len(pre):,} edges after dropping modulatory/unclear sources")

    nodes = np.unique(np.concatenate([pre, post]))
    n = len(nodes)
    index_of = {int(b): i for i, b in enumerate(nodes.tolist())}
    pi = np.fromiter((index_of[int(b)] for b in pre), dtype=np.uint32, count=len(pre))
    qi = np.fromiter((index_of[int(b)] for b in post), dtype=np.uint32, count=len(post))
    weights = (signs.astype(np.int32) * np.minimum(cnt, 32767).astype(np.int32)).astype(np.int16)
    print(f"  {n:,} nodes")

    order = np.lexsort((qi, pi))
    pi, qi, weights = pi[order], qi[order], weights[order]
    indptr = np.zeros(n + 1, dtype=np.uint32)
    counts = np.bincount(pi, minlength=n)
    indptr[1:] = np.cumsum(counts)

    # Map each sim node onto the row the viewer actually draws, so the worker can
    # emit an array BrainScene can hand straight to the GPU. -1 = not drawn.
    ids = np.fromfile(atlas / "ids.bin", dtype="<u4")
    groups = np.fromfile(atlas / "groups.bin", dtype="u1")
    drawn = ids[groups < 3]
    viewer_row = {int(b): i for i, b in enumerate(drawn.tolist())}
    viewer_map = np.full(n, -1, dtype=np.int32)
    for b, i in index_of.items():
        r = viewer_row.get(b)
        if r is not None:
            viewer_map[i] = r
    print(f"  {int((viewer_map >= 0).sum()):,} of {len(drawn):,} drawn somata are wired")

    group = np.array([GROUP_OF.get(superclass_of.get(int(b)) or "", 4) for b in nodes], dtype=np.uint8)

    def dump(name, arr):
        p = args.out / name
        arr.tofile(p)
        print(f"  wrote {name:<20} {p.stat().st_size/1e6:7.1f} MB")

    print("writing...")
    dump("indptr.bin", indptr)
    dump("indices.bin", qi)
    dump("weights.bin", weights)
    dump("nodes.bin", nodes.astype(np.uint32))
    dump("group.bin", group)
    dump("viewer_map.bin", viewer_map)

    # Named cell types, so the UI can target real circuits by name.
    by_type: dict[str, list[int]] = {}
    for b, i in index_of.items():
        t = type_of.get(b)
        if t:
            by_type.setdefault(t, []).append(i)

    meta = {
        "dataset": "male-cns:v1.0",
        "threshold": args.threshold,
        "nodes": int(n),
        "edges": int(len(qi)),
        "excitatoryEdges": int((weights > 0).sum()),
        "inhibitoryEdges": int((weights < 0).sum()),
        "viewerRows": int(len(drawn)),
        "groups": SUPERCLASS_ORDER,
        "lif": {
            "vRest": -52.0, "vReset": -52.0, "vThreshold": -45.0,
            "tauM": 20.0, "tauSyn": 5.0, "refractory": 2.2,
            "delay": 1.8, "mvPerSynapse": 0.275, "dt": 0.1,
            "units": "mV and ms; Shiu et al. 2024 Nature",
        },
        "attribution": "MaleCNS v1.0, FlyEM/HHMI Janelia, Univ. Cambridge, MRC LMB, Google Research (CC BY 4.0)",
        "types": {t: v for t, v in sorted(by_type.items())},
    }
    (args.out / "meta.json").write_text(json.dumps(meta))
    print(f"  wrote meta.json          {(args.out/'meta.json').stat().st_size/1e6:7.1f} MB "
          f"({len(by_type):,} named cell types)")
    print(f"\n{n:,} neurons, {len(qi):,} edges "
          f"({100*meta['excitatoryEdges']/len(qi):.0f}% excitatory)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
