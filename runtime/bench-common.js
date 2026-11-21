
/*
 * The benchmark both variants run (appended to each page script by
 * build.sh): 32 moves 350 ms apart, first idle, then while the app's thread
 * does background work (30 ms of every 50 ms), with video playing under the
 * page. Needs benchKey(key, applied), setBenchLoad(on) and playPreview().
 * Results: localStorage 'spike.bench2' (last 6).
 */
function runBench2(done) {
    var seqKeys = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown',
        'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight',
        'ArrowRight', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp',
        'ArrowUp', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft'];
    var results = { mode: M.mode, at: Date.now() };
    function scenario(label, load, next) {
        setBenchLoad(load);
        var lat = [], i = 0, gaps = 0, worst = 0, last = 0, ticking = true;
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
                    setBenchLoad(false);
                    var s = lat.slice().sort(function (a, b) { return a - b; });
                    results[label] = { n: s.length, p50: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1],
                        gapsOver50: gaps, worstGap: Math.round(worst) };
                    next();
                }, 800);
                return;
            }
            var key = seqKeys[i++];
            var t0 = performance.now();
            benchKey(key, function () {
                requestAnimationFrame(function () { requestAnimationFrame(function () { lat.push(Math.round(performance.now() - t0)); }); });
            });
            setTimeout(one, 350);
        }
        setTimeout(one, 500);
    }
    scenario('idle', false, function () {
        scenario('load', true, function () {
            try {
                var all = JSON.parse(localStorage.getItem('spike.bench2') || '[]');
                all.push(results);
                localStorage.setItem('spike.bench2', JSON.stringify(all.slice(-6)));
            } catch (e) { /* optional */ }
            window.__bench2 = results;
            if (done) done(results);
        });
    });
}
(function autoBench() {
    if (localStorage.getItem('spike.autobench') !== '2') return;
    var wait = setInterval(function () {
        if (keyListener == null) return;
        clearInterval(wait);
        setTimeout(function () { playPreview(); setTimeout(function () { runBench2(); }, 4000); }, 3000);
    }, 200);
})();
