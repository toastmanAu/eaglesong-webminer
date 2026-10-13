#!/usr/bin/env bash
# fetch-sources.sh — clone the pinned upstream sources into vendor/ at the exact
# commits recorded in docs/SOURCE_VERSIONS.md. vendor/ is gitignored; this
# script is the reproducible way to recreate it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
mkdir -p "$VENDOR"

fetch() {
  local repo="$1" name="$2" sha="$3"
  local dir="$VENDOR/$name"
  if [ ! -d "$dir/.git" ]; then
    git clone -q "https://github.com/$repo.git" "$dir"
  fi
  git -C "$dir" fetch -q origin
  git -C "$dir" checkout -q "$sha"
  echo "$name @ $(git -C "$dir" rev-parse HEAD)"
}

fetch toastmanAu/ckb-stratum-proxy ckb-stratum-proxy 027584a65202ee8b8d58509da90096867bb885ca
fetch toastmanAu/NerdMiner_CKB     NerdMiner_CKB     cc6d2fee5b7981d1adab5ce32d86e6073c6408ad
fetch nervosnetwork/eaglesong      eaglesong         39d3832dbbfb7cb513b89f4370b26793e30d9f18
