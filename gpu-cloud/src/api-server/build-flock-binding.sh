#!/bin/sh
# build-flock-binding.sh — rebuild the flock(2) N-API addon for NOVA Phase 5 Rev 4.8.
#
# Canonical source: flock-binding.cc (same directory).
# Build product:    flock-binding.node (same directory), loaded by flock-binding.mjs.
#
# Usage: ./build-flock-binding.sh
#   Run from any directory; the script resolves its own directory.
#   Requires: g++ and the Node N-API headers (/usr/include/node/node_api.h).
#   Exit non-zero on any failure; the .node is only replaced on success
#   (built to a temp file, then moved into place).
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$DIR/flock-binding.cc"
OUT="$DIR/flock-binding.node"
TMP="$DIR/.flock-binding.tmp.$$.node"

trap 'rm -f "$TMP"' EXIT

g++ -std=c++17 -shared -fPIC -O2 -I/usr/include/node \
  -o "$TMP" "$SRC"

# Sanity: the addon must load and export both functions before it replaces
# the installed file.
node -e "const b = require('$TMP'); \
  if (typeof b.flockExNb !== 'function' || typeof b.flockUn !== 'function') { \
    throw new Error('flock-binding: missing exports'); \
  }"

mv "$TMP" "$OUT"
trap - EXIT
echo "built $OUT"
