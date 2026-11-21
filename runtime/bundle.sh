#!/usr/bin/env bash
# Writes the platform's page and Worker scripts into DIR:
#   nsh-tizen.js   the page: renderer, native components, the AVPlay example,
#                  NshTizen.start
#   nsh-worker.js  the Worker: the engine host
#   nsh-engine.js  the engine host alone, for the page-thread benchmark page
#   nsh-bench.js   the shared benchmark, for benchmark builds only
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?output directory}"
cat "$here"/{renderer.js,avplay.js,page.js} > "$out/nsh-tizen.js"
cat "$here"/{engine.js,worker.js} > "$out/nsh-worker.js"
cp "$here/engine.js" "$out/nsh-engine.js"
cp "$here/bench.js" "$out/nsh-bench.js"
