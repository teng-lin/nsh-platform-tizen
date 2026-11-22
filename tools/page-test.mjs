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

// ES2017 only, by a real parse (acorn at ecmaVersion 2017) of what the
// package ships: the bundles, the host's scripts and any inline script,
// then a denylist of APIs Chromium 69 lacks and CSS it cannot read.
const acorn = await import('acorn');
const walk = await import('acorn-walk');
const API = new Set(['globalThis', 'WeakRef', 'FinalizationRegistry', 'fromEntries', 'allSettled', 'matchAll', 'replaceAll',
    'queueMicrotask', 'structuredClone', 'BigInt', 'hasOwn', 'findLast', 'findLastIndex', 'instantiateStreaming', 'compileStreaming',
    'replaceChildren', 'description']);
// Members that are fine elsewhere but not on these objects (Promise.any).
const MEMBERS = [['Promise', 'any']];
// Methods newer than Chromium 69 when called (a field named `at` is fine).
const CALLED = new Set(['at', 'toSorted', 'toReversed', 'toSpliced', 'with', 'findLast', 'flatMap']);
const CSS = [/(^|[;{\s])gap\s*:/, /\b(min|max|clamp)\(/, /(^|[;{\s])inset\s*:/, /aspect-ratio/];
function es2017(file, source) {
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 2017, sourceType: 'script', allowHashBang: false });
    } catch (e) {
        check(false, `${file} parses as ES2017: ${e.message}`);
        return;
    }
    const used = new Set();
    const css = new Set();
    walk.full(ast, (node) => {
        if (node.type === 'Identifier' && API.has(node.name)) used.add(node.name);
        if (node.type === 'MemberExpression' && !node.computed && API.has(node.property.name)) used.add(node.property.name);
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
            && CALLED.has(node.callee.property.name)) used.add(`.${node.callee.property.name}()`);
        if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier'
            && MEMBERS.some(([o, p]) => o === node.object.name && p === node.property.name)) used.add(`${node.object.name}.${node.property.name}`);
        if (node.type === 'Literal' && typeof node.value === 'string') CSS.forEach((r) => { if (r.test(node.value)) css.add(String(r)); });
    });
    check(used.size === 0 && css.size === 0, `${file} is ES2017 and uses no newer API or CSS ${[...used, ...css].join(' ')}`);
}
function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
function css(file, text) {
    const bad = CSS.filter((r) => r.test(text));
    check(bad.length === 0, `${file} has no CSS Chromium 69 cannot read ${bad.join(' ')}`);
}
for (const file of files(stage)) {
    const name = path.relative(stage, file);
    if (file.endsWith('.js')) es2017(name, fs.readFileSync(file, 'utf8'));
    if (file.endsWith('.css')) css(name, fs.readFileSync(file, 'utf8'));
    if (!file.endsWith('.html')) continue;
    const html = fs.readFileSync(file, 'utf8');
    const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)];
    check(inline.length === 0, `${name} has no inline script (the CSP allows none)`);
    inline.forEach((m, i) => es2017(`${name} inline ${i}`, m[1]));
    check(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), `${name} has no inline event handler`);
    [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].forEach((m) => css(`${name} <style>`, m[1]));
}

// The package's own policy (config.xml), served as the page's CSP header,
// with 'unsafe-eval' for the page-thread page as build.sh gives it.
const policy = /<tizen:content-security-policy>([^<]*)</.exec(fs.readFileSync(path.join(stage, 'config.xml'), 'utf8'));
check(!!policy, 'config.xml declares a CSP');
const csp = (file) => {
    if (!policy) return null;
    return file === 'page-thread.html' ? policy[1].replace("script-src 'self';", "script-src 'self' 'unsafe-eval';") : policy[1];
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
    const file = path.join(stage, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(stage) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    const headers = { 'content-type': types[path.extname(file)] || 'application/octet-stream' };
    if (file.endsWith('.html') && csp(path.basename(file))) headers['content-security-policy'] = csp(path.basename(file));
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-tizen-test-'));
// Detached: its own process group, so its helpers end with it.
const chrome = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1920,1080', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
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
    await p.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__cspViolations = []; document.addEventListener("securitypolicyviolation", function (e) { window.__cspViolations.push(e.violatedDirective + " " + e.blockedURI); });' });
    await p.call('Page.enable');
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

    // Down and OK back to back: OK plays the channel Down moved to.
    const label = 'Array.prototype.map.call(document.querySelectorAll("#app span"), function (s) { return s.textContent; }).filter(function (t) { return t.indexOf(" · ") >= 0 || t.indexOf("OK plays") >= 0; }).join("|")';
    await p.key(413);
    await p.until(label + '.indexOf("OK plays") >= 0', 3000);
    await p.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await p.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await p.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await p.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    check(await p.until(label + '.indexOf("Channel 3") >= 0', 5000), 'Down then OK at once plays the channel moved to: ' + await p.evaluate(label));

    // The TV keyboard's Done (65376) itself submits without playing.
    await p.key(413);
    await p.until(label + '.indexOf("OK plays") >= 0', 3000);
    await p.key(403);
    await p.until('document.activeElement.tagName === "INPUT"', 3000);
    await p.call('Input.insertText', { text: 'x' });
    await p.key(65376);
    check(await p.until('document.activeElement.tagName !== "INPUT"', 3000), 'Done (65376) blurs the input');
    await new Promise((r) => setTimeout(r, 300));
    check((await p.evaluate(label)).indexOf('OK plays') >= 0, 'and plays nothing');
    // Every key message the page sends the engine, counted from here.
    await p.evaluate('(function () { var s = NshTizen.session(); window.__sentKeys = []; var send = s.send; s.send = function (m) { if (m.t === "key") window.__sentKeys.push((m.down ? "down " : "up ") + m.keyCode); return send.call(s, m); }; return 1; })()');
    const sentKeys = 'window.__sentKeys.length';
    // A release whose press the page never saw reaches no app.
    const k00 = await p.evaluate(sentKeys);
    await p.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await new Promise((r) => setTimeout(r, 300));
    check(await p.evaluate(sentKeys) === k00, 'an orphan release sends nothing (' + k00 + ' → ' + await p.evaluate(sentKeys) + ')');

    // Typing on the TV keyboard: a digit types, an arrow moves the caret
    // (their defaults are the keyboard's), and nothing reaches the app.
    await p.key(403);
    await p.until('document.activeElement.tagName === "INPUT"', 3000);
    await p.evaluate('document.activeElement.value = "ab"; document.activeElement.setSelectionRange(2, 2); 1');
    const k01 = await p.evaluate(sentKeys);
    await p.call('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 53, nativeVirtualKeyCode: 53, key: '5', code: 'Digit5', text: '5' });
    await p.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 53, nativeVirtualKeyCode: 53, key: '5', code: 'Digit5' });
    check(await p.until('document.activeElement.value === "ab5"', 2000), 'a digit types: ' + await p.evaluate('document.activeElement.value'));
    const caret = await p.evaluate('document.activeElement.setSelectionRange(3, 3), document.activeElement.selectionStart');
    await p.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' });
    await p.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' });
    const moved = await p.evaluate('document.activeElement.selectionStart');
    check(caret > 0 && moved === caret - 1, `an arrow moves the caret (${caret} → ${moved})`);
    check(await p.evaluate(sentKeys) === k01, 'and neither reached the app');
    await p.key(65385);
    await p.until('document.activeElement.tagName !== "INPUT"', 3000);

    // Keys the input consumed reach no app: Done submits without playing,
    // Back leaves the input and is not a Back for the app.
    await p.key(413);
    await p.until(label + '.indexOf("OK plays") >= 0', 3000);
    await p.key(403);
    await p.until('document.activeElement.tagName === "INPUT"', 3000);
    await new Promise((r) => setTimeout(r, 300));
    const k0 = await p.evaluate(sentKeys);
    await p.key(13);
    await new Promise((r) => setTimeout(r, 500));
    check((await p.evaluate(label)).indexOf('OK plays') >= 0, 'Done in the input plays nothing: ' + await p.evaluate(label));
    check(await p.evaluate(sentKeys) === k0, 'and sends nothing, its release neither (' + k0 + ' → ' + await p.evaluate(sentKeys) + ')');
    await p.key(403);
    await p.until('document.activeElement.tagName === "INPUT"', 3000);
    await new Promise((r) => setTimeout(r, 300));
    const k1 = await p.evaluate(sentKeys);
    await p.key(10009);
    await new Promise((r) => setTimeout(r, 500));
    check(await p.evaluate('document.activeElement.tagName !== "INPUT"'), 'Back left the input');
    check(await p.evaluate(sentKeys) === k1, 'and reached no app (' + k1 + ' → ' + await p.evaluate(sentKeys) + ')');
    check(k1 === k0 + 2, 'Red sent its press and release (' + k0 + ' → ' + k1 + ')');
    // A bounced Back is one Back.
    await new Promise((r) => setTimeout(r, 700));
    const k2 = await p.evaluate(sentKeys);
    await p.key(10009);
    await p.key(10009);
    await new Promise((r) => setTimeout(r, 500));
    check(await p.evaluate(sentKeys) === k2 + 2, 'two Backs within the debounce are one press and release (' + k2 + ' → ' + await p.evaluate(sentKeys) + ')');

    // The runtime's own cases (components, images, the AVPlay example).
    const cases = await p.evaluate(fs.readFileSync(path.join(root, 'tools/runtime-cases.js'), 'utf8'));
    const violations = await p.evaluate('window.__cspViolations || []');
    check(violations.length === 0, `no CSP violations ${JSON.stringify(violations)}`);
    for (const [ok, what] of cases || [[false, 'runtime cases ran']]) check(ok, what);

    // An error storm, then a fatal trap: the host still hears the fatal,
    // and what is saved stays small.
    const storm = await p.evaluate(`(function () {
        var s = NshTizen.session(), heard = [];
        s.options.onError = function (t) { heard.push(t); };
        var long = new Array(400).join('x');
        for (var i = 0; i < 300; i++) s.error('error ' + i + ' ' + long);
        s.fatal('the app stopped: test');
        return JSON.stringify({ fatal: heard.indexOf('the app stopped: test') >= 0, saved: (localStorage.getItem('nsh.metrics') || '').length });
    })()`);
    const st = JSON.parse(storm);
    check(st.fatal, 'a fatal error reaches onError after 300 errors');
    check(st.saved < 60000, `saved metrics stay small (${st.saved} characters for five launches)`);

    // A second start replaces the first: one app on the page.
    await p.evaluate('NshTizen.start({ container: document.getElementById("app"), module: "app.wasm", version: window.NSH_MODULE_VERSION, thread: window.NSH_THREAD || "worker" }) && 1');
    check(await p.until('window.__nsh.firstPaintAt > 0', 20000), 'a second start paints');
    check(await p.evaluate('document.getElementById("app").children.length') === 1, 'and the first session\'s DOM is gone');

    // A session at scale 2 zooms the container and lays out in points; the
    // next session at scale 1 gets the container back as it was.
    const unzoomed = await p.evaluate('(function () { var a = document.getElementById("app"); return a.style.zoom + "|" + a.style.width + "|" + a.clientWidth; })()');
    await p.evaluate('NshTizen.start({ container: document.getElementById("app"), module: "app.wasm", version: window.NSH_MODULE_VERSION, thread: window.NSH_THREAD || "worker", scale: 2 }) && 1');
    check(await p.until('window.__nsh.firstPaintAt > 0', 20000), 'a start at scale 2 paints');
    const zoomed = JSON.parse(await p.evaluate(`(function () {
        var a = document.getElementById("app"), root = a.firstChild;
        return JSON.stringify({ zoom: a.style.zoom, w: a.style.width, rootW: root.style.width,
            fits: a.getBoundingClientRect().width <= window.innerWidth + 1 });
    })()`));
    check(zoomed.zoom === '2' && parseFloat(zoomed.rootW) * 2 === parseFloat(unzoomed.split('|')[2]) && zoomed.fits,
        'at scale 2 the root is half the container in points and the container stays in the window: ' + JSON.stringify(zoomed));
    await p.evaluate('NshTizen.start({ container: document.getElementById("app"), module: "app.wasm", version: window.NSH_MODULE_VERSION, thread: window.NSH_THREAD || "worker" }) && 1');
    check(await p.until('window.__nsh.firstPaintAt > 0', 20000), 'a start at scale 1 after it paints');
    const restored = await p.evaluate('(function () { var a = document.getElementById("app"); return a.style.zoom + "|" + a.style.width + "|" + a.clientWidth; })()');
    check(restored === unzoomed, 'and the container is as before the zoom: ' + unzoomed + ' / ' + restored);
    p.ws.close();
}

// Chrome and its helpers (the whole group), then the profile they wrote
// in; a profile left behind is not a test failure.
const exited = new Promise((ok) => chrome.once('exit', ok));
try { process.kill(-chrome.pid, 'SIGTERM'); } catch (e) { chrome.kill(); }
await Promise.race([exited, new Promise((ok) => setTimeout(ok, 5000))]);
try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { /* gone */ }
server.close();
await new Promise((ok) => setTimeout(ok, 300));
try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch (e) {
    console.log(`note: could not remove ${profile}: ${e.code}`);
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
