#!/usr/bin/env bash
# Drives the guide app on a TV (sdb connected, DevTools reachable):
#   tools/tv.sh install          install target/guide.wgt
#   tools/tv.sh debug            relaunch with DevTools; prints the port
#   tools/tv.sh eval FILE        evaluate FILE's expression on the page
#   tools/tv.sh shot OUT.png     screenshot
#   tools/tv.sh bench [RUNS]     the shared benchmark in RUNS normal launches (default 2)
# TV=host:port (default 192.168.1.157:26101), APP=NshSpike01.Guide.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PATH=$PATH:$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin
tv="${TV:-192.168.1.157:26101}"
host="${tv%%:*}"
app="${APP:-NshSpike01.Guide}"
pkg="${app%%.*}"
state="$here/../target/tv-port"
sdb() { command sdb -s "$tv" "$@"; }
debug() {
    timeout 10 sdb shell 0 kill "$pkg" >/dev/null 2>&1 || true
    sleep 1
    local out
    out=$(timeout 25 sdb shell 0 debug "$app" 2>&1 | tr -d '\r')
    echo "$out" | grep -o 'port: *[0-9]*' | grep -o '[0-9]*' | tail -1 > "$state"
    cat "$state"
}
evaluate() {
    local f="$1"
    [[ -f "$f" ]] || { printf '%s' "$f" > "$state.js"; f="$state.js"; }
    node "$here/cdp2.mjs" "$host" "$(cat "$state")" eval "$f"
}
case "${1:-}" in
install) tizen install -s "$tv" -n guide.wgt -- "$here/../target" | grep -E "success|Fail|error" ;;
debug) debug ;;
eval) evaluate "$2" ;;
shot) node "$here/cdp2.mjs" "$host" "$(cat "$state")" shot "$2" ;;
bench)
    debug >/dev/null; sleep 20
    evaluate "localStorage.setItem('nsh.autobench','1'); localStorage.removeItem('nsh.bench'); 'set'" >/dev/null
    for _ in $(seq "${2:-2}"); do
        timeout 10 sdb shell 0 kill "$pkg" >/dev/null 2>&1 || true; sleep 2
        tizen run -s "$tv" -p "$app" >/dev/null 2>&1
        sleep 60
    done
    debug >/dev/null; sleep 3
    evaluate "localStorage.setItem('nsh.autobench','0'); localStorage.getItem('nsh.bench')" | python3 -I -c "
import json,sys
for r in json.loads(sys.stdin.read() or '[]'):
    print(r['mode'], 'idle', json.dumps(r.get('idle')), '| load', json.dumps(r.get('load')), '| engine/key', json.dumps(r.get('engine')), '| dom', r.get('domNodes'))"
    ;;
*) sed -n '2,8p' "$0"; exit 1 ;;
esac
