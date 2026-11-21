// Desktop run of the chunk VFS probe: build, flush, small change, sliced publish, reload.
import fs from 'node:fs';
const b = fs.readFileSync(process.argv[2]);
let i; const make = () => new WebAssembly.Instance(new WebAssembly.Module(b), { env: { host_now_ms: () => Date.now(), host_random: (p, l) => {} } });
i = make(); let e = i.exports;
const now = () => performance.now();
console.log('init', e.init());
let t = now(); console.log('build MB', (e.build(7257, 250000) / 1048576).toFixed(1), Math.round(now() - t), 'ms');
const store = new Map();
function flush() { const n = e.dirty_take(); let bytes = 0; for (let k = 0; k < n; k++) { const idx = e.dirty_index(k); const p = e.chunk_ptr(idx); const len = e.chunk_len(); store.set(idx, new Uint8Array(e.memory.buffer, p, len).slice()); bytes += len; } return [n, bytes]; }
t = now(); console.log('flush all', flush(), Math.round(now() - t), 'ms');
e.toggle_favorite(42); console.log('small change dirty chunks', flush());
t = now(); e.publish_begin(); let left = 250000, worst = 0, slices = 0;
while (left > 0) { const s0 = now(); left = e.publish_slice(2000, 250000, 7257); worst = Math.max(worst, now() - s0); slices++; e.queries(5); }
console.log('publish', Math.round(now() - t), 'ms; slices', slices, 'worst slice', worst.toFixed(1), 'ms; finish', e.publish_finish());
console.log('after publish dirty', flush(), 'count', e.count());
const size = e.file_size();
i = make(); e = i.exports; e.load_begin(size);
for (const [idx, bytes] of store) new Uint8Array(e.memory.buffer, e.load_chunk(idx), bytes.length).set(bytes);
console.log('reload init', e.init(), 'count', e.count(), 'queries', e.queries(100));
