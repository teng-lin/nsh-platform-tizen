/*
 * Spike, Worker variant, page side: draws the operations the engine (in
 * worker.js) commits, forwards keys, plays video, and benchmarks itself.
 * Plain ES2017 (Chromium 69).
 */
'use strict';

var ROOT_ID = 1;
var KEYS_BIT = 8;
var PREVIEW = [1184, 32, 704, 396];
var STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
var M = { mode: 'worker', at: Date.now(), batches: 0, ops: 0, applyMs: 0, parseMs: 0, unknown: {} };
window.__spike = M;
var nodes = {};
var keyListener = null;
function Node(id, kind) {
    this.id = id;
    this.kind = kind;
    this.el = document.createElement('div');
    this.frame = 'left:0;top:0;';
    this.css = '';
    this.anim = '';
    this.textEl = null;
    this.events = 0;
}
Node.prototype.restyle = function () {
    this.el.style.cssText = 'position:absolute;box-sizing:border-box;' + this.frame + this.css + this.anim;
};
function node(id) { return nodes[id]; }

(function makeRoot() {
    var root = new Node(ROOT_ID, 'view');
    root.frame = 'left:0;top:0;width:1920px;height:1080px;';
    root.restyle();
    nodes[ROOT_ID] = root;
    document.getElementById('app').appendChild(root.el);
})();

function applyText(n, spec) {
    if (n.textEl) n.el.removeChild(n.textEl);
    var box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:' + spec.x + 'px;top:' + spec.y + 'px;white-space:pre;';
    for (var i = 0; i < spec.runs.length; i++) {
        var run = spec.runs[i];
        var span = document.createElement('span');
        span.style.cssText = 'position:absolute;left:' + run[1] + 'px;top:' + run[2] + 'px;line-height:' +
            run[3] + 'px;' + (spec.styles[run[4]] || '');
        span.textContent = run[0];
        box.appendChild(span);
    }
    n.textEl = box;
    n.el.appendChild(box);
}

function apply(ops) {
    var started = performance.now();
    for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        var n = node(op[1]);
        switch (op[0]) {
        case 'c':
            if (op[1] === ROOT_ID) break; /* the page made the root */
            nodes[op[1]] = new Node(op[1], op[2]);
            nodes[op[1]].restyle();
            if (op[2] === 'scroll') nodes[op[1]].css = 'overflow:hidden;';
            break;
        case 'i': {
            var child = node(op[2]);
            if (!n || !child) break;
            var before = op[3] == null ? null : node(op[3]);
            n.el.insertBefore(child.el, before ? before.el : null);
            break;
        }
        case 'r':
            if (n && n.el.parentNode) n.el.parentNode.removeChild(n.el);
            break;
        case 'd':
            if (n) {
                if (n.el.parentNode) n.el.parentNode.removeChild(n.el);
                delete nodes[op[1]];
                if (keyListener === op[1]) keyListener = null;
            }
            break;
        case 'f':
            if (n) { n.frame = 'left:' + op[2] + 'px;top:' + op[3] + 'px;width:' + op[4] + 'px;height:' + op[5] + 'px;'; n.restyle(); }
            break;
        case 's':
            if (n) { n.css = op[2]; n.restyle(); }
            break;
        case 'a':
            if (n) { n.anim = op[2]; n.restyle(); }
            break;
        case 't':
            if (n) applyText(n, op[2]);
            break;
        case 'e':
            if (n) {
                n.events = op[2];
                if (op[2] & KEYS_BIT) keyListener = op[1];
                else if (keyListener === op[1]) keyListener = null;
            }
            break;
        case 'im':
            if (n) {
                var img = n.el.querySelector('img') || n.el.appendChild(document.createElement('img'));
                img.style.cssText = 'width:100%;height:100%;object-fit:' + (op[3] === 'aspectFill' ? 'cover' : 'contain');
                if (op[2]) img.src = op[2]; else img.removeAttribute('src');
            }
            break;
        default:
            M.unknown[op[0]] = (M.unknown[op[0]] || 0) + 1;
        }
    }
    M.batches++;
    M.ops += ops.length;
    M.applyMs += performance.now() - started;
}

/* ---------- the module's imports ---------- */

/* ---------- the engine in the worker ---------- */
var worker = new Worker('worker.js');
var frameAsked = false;
var waiting = {};
var seq = 0;
worker.onmessage = function (e) {
    var m = e.data;
    if (m.t === 'ops') {
        var p0 = performance.now();
        var parsed = m.batches.map(function (b) { return JSON.parse(b); });
        M.parseMs += performance.now() - p0;
        parsed.forEach(apply);
        if (m.first) { M.firstPaintAt = 0; requestAnimationFrame(function () { requestAnimationFrame(function () { M.firstPaintAt = Math.round(performance.now()); }); }); }
        if (m.seq !== undefined && waiting[m.seq]) { waiting[m.seq](m); delete waiting[m.seq]; }
    } else if (m.t === 'frame') {
        if (frameAsked) return;
        frameAsked = true;
        requestAnimationFrame(function () { frameAsked = false; worker.postMessage({ t: 'frame' }); });
    } else if (m.t === 'metrics') {
        M.worker = m.m;
    } else if (m.t === 'stats') {
        if (waiting.stats) { waiting.stats(m.s); delete waiting.stats; }
    }
};
function sendKey(key, down, done) {
    var s = ++seq;
    if (done) waiting[s] = done;
    worker.postMessage({ t: 'key', key: key, down: down, seq: s, listener: keyListener, sentAt: Date.now() });
}
var KEY_NAMES = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 10009: 'GoBack' };
document.addEventListener('keydown', function (e) {
    var key = KEY_NAMES[e.keyCode];
    if (!key || keyListener == null) return;
    e.preventDefault();
    sendKey(key, true);
});

/* ---------- video under the page while benchmarking ---------- */
function playPreview() {
    try {
        var av = webapis.avplay;
        av.open(STREAM);
        av.setDisplayRect(PREVIEW[0], PREVIEW[1], PREVIEW[2], PREVIEW[3]);
        av.prepareAsync(function () { av.play(); }, function () {});
    } catch (e) { M.playError = String(e); }
}

/* ---------- benchmark: the same as the page variant's ---------- */
function benchKey(key, applied) { sendKey(key, true, applied); sendKey(key, false); }
function setBenchLoad(on) { worker.postMessage({ t: 'load', on: on }); }
