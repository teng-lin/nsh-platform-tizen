#!/usr/bin/env bash
# Builds the guide app for Tizen 5.5 (MVP WebAssembly + sign-extension +
# mutable globals, a rebuilt std on the pinned nightly) and signs a .wgt.
# --install HOST:PORT also installs it. Needs TIZEN_SIGNING_PROFILE and
# Tizen Studio's CLI.
#
#   NSH_PAGE=page-thread.html  start the page-thread benchmark variant
#   NSH_OPT=s|z|3              opt-level (default 3)
#   NSH_FEATURES=...           guide-spike features (ballast)
#   NSH_FONT=path.ttf          ship a font and register it from the host page
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
nightly="$("$root/../patina-iptv/tools/ci/fuzz-imports.sh" --toolchain)"
RUSTFLAGS="-C target-cpu=mvp -C target-feature=+sign-ext,+mutable-globals" \
    cargo "+$nightly" build -Zbuild-std=std,panic_abort --target wasm32-unknown-unknown \
    --release -p guide-spike ${NSH_FEATURES:+--features "$NSH_FEATURES"} --target-dir "$root/target/tizen-wasm" \
    --config "profile.release.opt-level=${NSH_OPT:-3}"
stage="$root/target/stage"
rm -rf "$stage" && mkdir -p "$stage/assets"
"$root/runtime/bundle.sh" "$stage"
cp "$root"/app/{index.html,page-thread.html,host.js} "$stage/"
sed "s|<content src=\"index.html\"/>|<content src=\"${NSH_PAGE:-index.html}\"/>|" "$root/app/config.xml" > "$stage/config.xml"
cp "$root/../patina-iptv/art/icon/play-512.png" "$stage/icon.png"
cp "$root/../patina-iptv/art/icon/play-512.png" "$stage/assets/logo.png"
if [[ -n "${NSH_FONT:-}" ]]; then
    mkdir -p "$stage/fonts" && cp "$NSH_FONT" "$stage/fonts/host.ttf"
    sed -i 's|<script src="host.js">|<script>window.NSH_FONTS = [{ family: "Host Font", url: "fonts/host.ttf" }];</script>\n<script src="host.js">|' "$stage/index.html" "$stage/page-thread.html"
fi
cp "$root/target/tizen-wasm/wasm32-unknown-unknown/release/guide_spike.wasm" "$stage/app.wasm"
ls -la "$stage/app.wasm"
tizen="$(command -v tizen || echo "$HOME/tizen-studio/tools/ide/bin/tizen")"
"$tizen" package -t wgt -s "${TIZEN_SIGNING_PROFILE:?set TIZEN_SIGNING_PROFILE}" -- "$stage" >/dev/null
mv "$stage"/*.wgt "$root/target/guide.wgt"
if [[ "${1:-}" == "--install" ]]; then
    "$tizen" install -s "$2" -n guide.wgt -- "$root/target"
fi
