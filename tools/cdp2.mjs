// node cdp2.mjs host port eval <file-with-expression> | shot <out.png>
import fs from 'node:fs';
const [host, port, mode, arg] = process.argv.slice(2);
const pages = await (await fetch(`http://${host}:${port}/json`)).json();
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
const call = (method, params) => new Promise((ok) => {
    const id = Math.floor(Math.random() * 1e9);
    const on = (m) => { const msg = JSON.parse(m.data); if (msg.id === id) { ws.removeEventListener('message', on); ok(msg); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
});
if (mode === 'eval') {
    const r = await call('Runtime.evaluate', { expression: fs.readFileSync(arg, 'utf8'), returnByValue: true, awaitPromise: true });
    const v = r.result && r.result.result;
    console.log(v && v.value !== undefined ? (typeof v.value === 'string' ? v.value : JSON.stringify(v.value)) : JSON.stringify(r).slice(0, 800));
} else if (mode === 'shot') {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
    console.log('saved', arg);
}
ws.close();
