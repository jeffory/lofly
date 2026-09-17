#!/usr/bin/env bash
# Fetch the three MaleCNS v1.0 tables that pack-connectome.py needs.
#
# These are not kept in the repo: they are 1.06 GB, they are only needed when
# re-packing at a different synapse threshold, and they are a published,
# versioned, CC-BY dataset that is not going to move. Re-fetching takes a couple
# of minutes, which is cheaper than storing them.
#
# Usage: scripts/fetch-source-data.sh [dest-dir]     (default: ./source-data)
set -euo pipefail

BASE="https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/source-data}"
FILES=(
  "connectome-weights-male-cns-v1.0-minconf-0.5.feather"      # 1003 MB, the graph
  "body-annotations-male-cns-v1.0-minconf-0.5.feather"        #   14 MB, types and classes
  "body-neurotransmitters-male-cns-v1.0.feather"              #   41 MB, excitatory/inhibitory
)

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  if [ -s "$DEST/$f" ]; then
    echo "have  $f"
  else
    echo "fetch $f"
    curl -fL --progress-bar -o "$DEST/$f.part" "$BASE/$f"
    mv "$DEST/$f.part" "$DEST/$f"
  fi
done

cat <<EOF

Done. Now pack the browser connectome:

  python -m venv .venv && .venv/bin/pip install pyarrow numpy
  .venv/bin/python scripts/pack-connectome.py "$DEST" --threshold 5

MaleCNS v1.0 is CC BY 4.0 — FlyEM / HHMI Janelia, University of Cambridge,
MRC Laboratory of Molecular Biology and Google Research.
EOF
