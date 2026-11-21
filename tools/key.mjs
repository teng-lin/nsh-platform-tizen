// node key.mjs host port code...  (Windows virtual key codes, like the remote's)
const [host, port, ...codes] = process.argv.slice(2);
const pages = await (await fetch(`http://${host}:${port}/json`)).json();
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((ok) => { ws.onopen = ok; });
let id = 1;
for (const c of codes) {
    const code = Number(c);
    for (const type of ['rawKeyDown', 'keyUp']) {
        ws.send(JSON.stringify({ id: id++, method: 'Input.dispatchKeyEvent', params: { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code } }));
    }
    await new Promise((r) => setTimeout(r, 350));
}
ws.close();
