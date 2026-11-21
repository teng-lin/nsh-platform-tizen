// node tools/profile.mjs host port seconds: CPU profile of the page for
// `seconds`, top functions by self time.
const [host, port, seconds] = process.argv.slice(2);
const pages = await (await fetch(`http://${host}:${port}/json`)).json();
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
let id = 0;
const call = (method, params = {}) => new Promise((ok) => {
    const n = ++id;
    const on = (m) => { const msg = JSON.parse(m.data); if (msg.id === n) { ws.removeEventListener('message', on); ok(msg); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: n, method, params }));
});
await call('Profiler.enable');
await call('Profiler.setSamplingInterval', { interval: 200 });
await call('Profiler.start');
await new Promise((r) => setTimeout(r, Number(seconds || 10) * 1000));
const { result } = await call('Profiler.stop');
const p = result.profile;
const self = new Map();
const dt = (p.endTime - p.startTime) / p.samples.length / 1000;
const byId = new Map(p.nodes.map((n) => [n.id, n]));
for (const s of p.samples) {
    const n = byId.get(s);
    const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
    self.set(key, (self.get(key) || 0) + dt);
}
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log(v.toFixed(1).padStart(8), 'ms', k));
ws.close();
