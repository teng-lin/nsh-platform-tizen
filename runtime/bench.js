'use strict';
/*
 * The shared benchmark, nsh-bench.js: only benchmark builds load it
 * (build.sh NSH_BENCH=1), after nsh-tizen.js. 32 moves
 * 350 ms apart, first idle, then while the app's thread works 30 ms of
 * every 50 ms, with video playing under the page. Records key to painted
 * frame, page frame gaps, and per key the DOM apply, JSON parse and
 * operation counts. Results: localStorage 'nsh.bench' (last 6).
 * Started when localStorage 'nsh.autobench' is '1', or with
 * NshTizen.runBench(done).
 */
(function (api) {
    api.benchBuild = true;

    /* The hooks the benchmark drives the running app with. */
    var BENCH_CODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13 };
    api.benchKey = function (key, applied) {
        var session = api.session(), code = BENCH_CODES[key];
        var s = ++session.seq;
        session.waiting[s] = function () { applied(); };
        session.send({ t: 'key', id: 0, keyCode: code, key: key, code: key, down: 1, repeat: 0, seq: s });
        session.send({ t: 'key', id: 0, keyCode: code, key: key, code: key, down: 0, repeat: 0 });
    };
    api.setBenchLoad = function (on) {
        var session = api.session();
        if (session.worker) { session.worker.postMessage({ t: 'load', on: on }); return; }
        clearInterval(api.pageLoad);
        api.pageLoad = on ? setInterval(function () { var end = performance.now() + 30; while (performance.now() < end) { /* work */ } }, 50) : null;
    };
    api.stats = function (done) { var session = api.session(); session.waiting.stats = done; session.send({ t: 'stats' }); };
    api.ready = function () { var session = api.session(); return !!(session && session.M.firstPaintAt); };

    function run(done) {
        var M = api.metrics;
        var seqKeys = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown',
            'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight',
            'ArrowRight', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp',
            'ArrowUp', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft'];
        var results = { mode: M.mode, at: Date.now() };
        api.stats(function () { /* zero the engine's counters */ });
        function scenario(label, load, next) {
            api.setBenchLoad(load);
            var lat = [], i = 0, gaps = 0, worst = 0, last = 0, ticking = true;
            var a0 = M.applyMs, p0 = M.parseMs, o0 = M.ops;
            (function tick(now) {
                if (!ticking) return;
                if (last && now - last > 50) { gaps++; worst = Math.max(worst, now - last); }
                last = now;
                requestAnimationFrame(tick);
            })(0);
            function one() {
                if (i >= seqKeys.length) {
                    setTimeout(function () {
                        ticking = false;
                        api.setBenchLoad(false);
                        var s = lat.slice().sort(function (a, b) { return a - b; });
                        var n = seqKeys.length;
                        results[label] = { n: s.length, p50: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1],
                            gapsOver50: gaps, worstGap: Math.round(worst),
                            applyMs: +((M.applyMs - a0) / n).toFixed(2), parseMs: +((M.parseMs - p0) / n).toFixed(2),
                            ops: +((M.ops - o0) / n).toFixed(1) };
                        next();
                    }, 800);
                    return;
                }
                var key = seqKeys[i++];
                var t0 = performance.now();
                api.benchKey(key, function () {
                    requestAnimationFrame(function () { requestAnimationFrame(function () { lat.push(Math.round(performance.now() - t0)); }); });
                });
                setTimeout(one, 350);
            }
            setTimeout(one, 500);
        }
        scenario('idle', false, function () {
            scenario('load', true, function () {
                api.stats(function (s) {
                    var per = {};
                    for (var k in s) per[k] = +(s[k] / (2 * seqKeys.length)).toFixed(2);
                    results.engine = per;
                    results.domNodes = document.getElementsByTagName('*').length;
                    try {
                        var all = JSON.parse(localStorage.getItem('nsh.bench') || '[]');
                        all.push(results);
                        localStorage.setItem('nsh.bench', JSON.stringify(all.slice(-6)));
                    } catch (e) { /* optional */ }
                    window.__bench = results;
                    if (done) done(results);
                });
            });
        });
    }
    api.runBench = run;
    var auto = null;
    try { auto = localStorage.getItem('nsh.autobench'); } catch (e) { /* none */ }
    if (auto !== '1') return;
    var wait = setInterval(function () {
        if (!api.ready()) return;
        clearInterval(wait);
        /* OK plays the focused channel: video under the page. */
        setTimeout(function () {
            api.benchKey('Enter', function () {});
            setTimeout(function () { run(); }, 4000);
        }, 3000);
    }, 200);
})(NshTizen);
