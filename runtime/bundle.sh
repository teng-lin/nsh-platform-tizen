#!/usr/bin/env bash
# Writes the platform's page and Worker scripts into DIR:
#   nsh-tizen.js   the page: renderer, native components, the AVPlay example,
#                  NshTizen.start, the shared benchmark
#   nsh-worker.js  the Worker: the engine host
#   nsh-engine.js  the engine host alone, for the page-thread benchmark page
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?output directory}"
cat "$here"/{renderer.js,avplay.js,page.js,bench-common.js} > "$out/nsh-tizen.js"
cat "$here"/{engine.js,worker.js} > "$out/nsh-worker.js"
cp "$here/engine.js" "$out/nsh-engine.js"
