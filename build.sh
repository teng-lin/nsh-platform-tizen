#!/usr/bin/env bash
# Builds the spike for Tizen 5.5 (MVP WebAssembly + sign-extension, like
# Patina's hosts/tizen/build.sh) and signs a .wgt; --install HOST:PORT also
# installs and starts it. Needs TIZEN_SIGNING_PROFILE and Tizen Studio's CLI.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
nightly="$("$root/../patina-iptv/tools/ci/fuzz-imports.sh" --toolchain)"
RUSTFLAGS="-C target-cpu=mvp -C target-feature=+sign-ext,+mutable-globals" \
    cargo "+$nightly" build -Zbuild-std=std,panic_abort --target wasm32-unknown-unknown \
    --release -p guide-spike ${SPIKE_FEATURES:+--features "$SPIKE_FEATURES"} --target-dir "$root/target/tizen-wasm" \
    --config "profile.release.opt-level=${SPIKE_OPT:-3}"
stage="$root/target/stage"
rm -rf "$stage" && mkdir -p "$stage"
cp "$root"/app/{index.html,worker.html} "$root/runtime/worker.js" "$stage/"
cat "$root/runtime/nsh-tz.js" "$root/runtime/bench-common.js" > "$stage/nsh-tz.js"
cat "$root/runtime/page-worker.js" "$root/runtime/bench-common.js" > "$stage/page-worker.js"
# SPIKE_PAGE=worker.html starts the Worker variant.
sed "s|<content src=\"index.html\"/>|<content src=\"${SPIKE_PAGE:-index.html}\"/>|" "$root/app/config.xml" > "$stage/config.xml"
cp "$root/../patina-iptv/art/icon/play-512.png" "$stage/icon.png"
cp "$root/target/tizen-wasm/wasm32-unknown-unknown/release/guide_spike.wasm" "$stage/app.wasm"
ls -la "$stage/app.wasm"
tizen="$(command -v tizen || echo "$HOME/tizen-studio/tools/ide/bin/tizen")"
"$tizen" package -t wgt -s "${TIZEN_SIGNING_PROFILE:?set TIZEN_SIGNING_PROFILE}" -- "$stage"
mv "$stage"/*.wgt "$root/target/spike.wgt" 2>/dev/null || mv "$stage/NSH Spike.wgt" "$root/target/spike.wgt"
if [[ "${1:-}" == "--install" ]]; then
    "$tizen" install -s "$2" -n spike.wgt -- "$root/target"
fi
