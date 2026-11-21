#!/usr/bin/env bash
# Builds the guide app for Tizen 5.5 (MVP WebAssembly + sign-extension +
# mutable globals, a rebuilt std on the pinned nightly) and signs a .wgt.
# --install HOST:PORT also installs it. Needs TIZEN_SIGNING_PROFILE and
# Tizen Studio's CLI.
#
#   NSH_PAGE=page-thread.html  start the page-thread benchmark variant
#   NSH_BENCH=1                include the shared benchmark (nsh-bench.js)
#   NSH_OPT=s|z|3              opt-level (default 3)
#   NSH_NIGHTLY=...            the nightly toolchain (default: Patina's pin)
#   NSH_FEATURES=...           guide-spike features (ballast)
#   NSH_FONT=path.ttf          ship a font and register it from the host page ("Host Font")
#   NSH_APP_FONT=path.ttf NSH_APP_FONT_FAMILY=name
#                              compile a font into the app (feature app-font)
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
# The nightly Patina pins (its rebuilt std targets this TV generation).
nightly="${NSH_NIGHTLY:-nightly-2026-10-24}"
features="${NSH_FEATURES:-}"
if [[ -n "${NSH_APP_FONT:-}" ]]; then
    export NSH_APP_FONT NSH_APP_FONT_FAMILY
    features="${features:+$features,}app-font"
fi
RUSTFLAGS="-C target-cpu=mvp -C target-feature=+sign-ext,+mutable-globals" \
    cargo "+$nightly" build -Zbuild-std=std,panic_abort --target wasm32-unknown-unknown \
    --release -p guide-spike ${features:+--features "$features"} --target-dir "$root/target/tizen-wasm" \
    --config "profile.release.opt-level=${NSH_OPT:-3}"
stage="$root/target/stage"
rm -rf "$stage" && mkdir -p "$stage/assets"
"$root/runtime/bundle.sh" "$stage"
cp "$root"/app/{index.html,page-thread.html,page.css,page-thread.js,host.js} "$stage/"
sed "s|<content src=\"index.html\"/>|<content src=\"${NSH_PAGE:-index.html}\"/>|" "$root/app/config.xml" > "$stage/config.xml"
# The page-thread benchmark compiles WebAssembly on the page: Chromium 69
# allows that only with 'unsafe-eval'. The Worker build does without.
if [[ "${NSH_PAGE:-}" == page-thread.html ]]; then
    sed -i "s|script-src 'self';|script-src 'self' 'unsafe-eval';|" "$stage/config.xml"
fi
cp "$root/app/icon.png" "$stage/icon.png"
cp "$root/app/icon.png" "$stage/assets/logo.png"
cp "$root/target/tizen-wasm/wasm32-unknown-unknown/release/guide_spike.wasm" "$stage/app.wasm"
# The module's SHA-256 keys the compiled-module cache: a rebuilt module
# never runs the old compiled code.
version="$(sha256sum "$stage/app.wasm" | cut -c1-64)"
fonts="[]"
if [[ -n "${NSH_FONT:-}" ]]; then
    mkdir -p "$stage/fonts" && cp "$NSH_FONT" "$stage/fonts/host.ttf"
    fonts='[{ family: "Host Font", url: "fonts/host.ttf" }]'
fi
printf "/* Written by build.sh. */\nwindow.NSH_MODULE_VERSION = '%s';\nwindow.NSH_FONTS = %s;\n" "$version" "$fonts" > "$stage/app-config.js"
if [[ -n "${NSH_BENCH:-}" ]]; then
    sed -i 's|<!--bench-->|<script src="nsh-bench.js"></script>|' "$stage/index.html" "$stage/page-thread.html"
else
    rm "$stage/nsh-bench.js"
fi
ls -la "$stage/app.wasm"
tizen="$(command -v tizen || echo "$HOME/tizen-studio/tools/ide/bin/tizen")"
"$tizen" package -t wgt -s "${TIZEN_SIGNING_PROFILE:?set TIZEN_SIGNING_PROFILE}" -- "$stage" >/dev/null
mv "$stage"/*.wgt "$root/target/guide.wgt"
if [[ "${1:-}" == "--install" ]]; then
    "$tizen" install -s "$2" -n guide.wgt -- "$root/target"
fi
