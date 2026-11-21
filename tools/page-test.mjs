// End-to-end check of the page runtime in headless Chromium, with the real
// module: serves target/stage (./build.sh first), loads index.html (Worker)
// and page-thread.html, and drives them through the DevTools protocol:
// first render, remote keys, a focused input taking text and submitting,
// an image's load event, the native component's events. Off the TV there
// is no AVPlay: the example component reports `unavailable`.
//
//   node tools/page-test.mjs [chromium]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const stage = path.join(root, 'target/stage');
const browser = process.argv[2] || 'chromium';
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// ES2017 only: what Chromium 69 cannot parse must not be in the runtime.
for (const f of ['renderer.js', 'engine.js', 'worker.js', 'page.js', 'avplay.js', 'bench-common.js']) {
    const src = fs.readFileSync(path.join(root, 'runtime', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'/g, "''");
    const bad = [/\?\./, /\?\?/, /\bglobalThis\b/, /\bWeakRef\b/, /\bclass\s+\w+\s*\{[^}]*#/, /\.at\(/, /\bimport\s*\(/, /\*\*=/].filter((r) => r.test(src));
    check(bad.length === 0, `${f} has no syntax past ES2017 ${bad.join(' ')}`);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
    const file = path.join(stage, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(stage) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-tizen-test-'));
const chrome = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1920,1080', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((ok, fail) => {
    let err = '';
    chrome.stderr.on('data', (d) => { err += d; const m = /ws:\/\/[^\s]+/.exec(err); if (m) ok(m[0]); });
    setTimeout(() => fail(new Error('no DevTools endpoint: ' + err)), 15000);
});
const port = new URL(wsUrl).port;

async function page() {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    let id = 0;
    const calls = new Map();
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (calls.has(msg.id)) { calls.get(msg.id)(msg); calls.delete(msg.id); } };
    const call = (method, params = {}) => new Promise((ok) => { const n = ++id; calls.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async (expression) => {
        const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const key = async (code, key = '') => {
        for (const type of ['rawKeyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key });
    };
    const until = async (expression, ms = 20000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (await evaluate(expression)) return true;
            await new Promise((r) => setTimeout(r, 100));
        }
        return false;
    };
    return { ws, call, evaluate, key, until };
}

const text = 'Array.prototype.map.call(document.querySelectorAll("#app span"), function (s) { return s.textContent; }).join("|")';

for (const file of ['index.html', 'page-thread.html']) {
    console.log(`# ${file}`);
    const p = await page();
    await p.call('Page.navigate', { url: `${base}/${file}` });
    check(await p.until('window.__nsh && window.__nsh.firstPaintAt > 0'), 'first render painted');
    const m = await p.evaluate('JSON.stringify({ mode: __nsh.mode, views: __nsh.views, unknown: __nsh.unknown, comps: __nsh.unknownComponents, errors: __nsh.errors, keys: Object.keys(NshTizen.renderer.nodes).length })');
    const metrics = JSON.parse(m);
    check(metrics.mode === (file === 'index.html' ? 'worker' : 'page'), `runs in the ${metrics.mode}`);
    check(metrics.views > 150, `${metrics.views} views`);
    check(Object.keys(metrics.unknown).length === 0, `no unknown operations ${JSON.stringify(metrics.unknown)}`);
    check(metrics.errors.length === 0, `no errors ${JSON.stringify(metrics.errors)}`);
    check(await p.until('document.querySelector("#app img") && document.querySelector("#app img").complete'), 'the logo image is shown');
    check(await p.until(text + '.indexOf("logo 512×512") >= 0'), 'its load event reached the app');
    const before = await p.evaluate(text);
    await p.key(40);
    check(await p.until(text + ' !== ' + JSON.stringify(before), 5000), 'ArrowDown moved the focus');
    await p.key(13);
    check(await p.until(text + '.indexOf("error unavailable") >= 0', 5000), 'OK played: the native component got its source and its event reached the app');
    // Red (403) focuses the search input; text and Done (Enter) come back.
    await p.key(403);
    check(await p.until('document.activeElement && document.activeElement.tagName === "INPUT"', 5000), 'Red focused the input');
    await p.call('Input.insertText', { text: 'news' });
    check(await p.until('document.activeElement.value === "news"', 3000), 'the input took the text');
    await p.key(13);
    check(await p.until('document.querySelector("#app input").value === "news ✓"', 5000), 'submit reached the app, and its value came back');
    check(await p.until('document.activeElement.tagName !== "INPUT"', 3000), 'submit blurred the input');
    const reused = await p.evaluate('(function () { var a = document.querySelectorAll("#app span").length; return a; })()');
    for (let i = 0; i < 6; i++) await p.key(39);
    await new Promise((r) => setTimeout(r, 500));
    const after = await p.evaluate('document.querySelectorAll("#app span").length');
    check(Math.abs(after - reused) < 20, `text spans are reused (${reused} → ${after})`);
    p.ws.close();
}

chrome.kill();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
