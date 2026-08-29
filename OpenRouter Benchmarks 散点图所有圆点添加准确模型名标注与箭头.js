// ==UserScript==
// @name         OpenRouter Benchmarks 散点图所有圆点添加准确模型名标注与箭头
// @namespace    https://openrouter.ai/rankings
// @version      2.3.0
// @description  为 OpenRouter Rankings Benchmarks 散点图所有圆点添加准确模型名标注与箭头；自动避让；双击隐藏；拖拽移动；重置按钮；自动开启 Pareto
// @match        https://openrouter.ai/rankings*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    var VERSION = '2.3.0';
    var OV_ID = 'orl-overlay-svg';
    var BTN_ID = 'orl-reset-btn';
    var LOG = '[ORL]';

    var busy = false;
    var pendingTimer = null;
    var paretoTried = false;
    var hiddenNames = {};
    var customPos = {};
    var currentLabels = [];
    var STORE_KEY = 'orl-scatter-labeler-v1';
    function loadStore() {
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (!raw) return;
            var data = JSON.parse(raw);
            if (data.pos) customPos = data.pos;
            if (data.hidden) hiddenNames = data.hidden;
            log('store loaded');
        } catch (e) { log('load store error', e); }
    }
    function saveStore() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({ pos: customPos, hidden: hiddenNames }));
        } catch (e) { log('save store error', e); }
    }
    function log() {
        try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function isParetoOn() {
        var sw = document.querySelector('#show-pareto');
        if (!sw) return false;
        return sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('data-state') === 'checked';
    }
    function autoPareto() {
        if (paretoTried) return;
        var sw = document.querySelector('#show-pareto');
        if (!sw) return;
        paretoTried = true;
        if (sw.getAttribute('aria-checked') !== 'true') {
            sw.click();
            log('auto-enabled Show Pareto');
        }
    }

    // ---------------- 数据提取与映射 ----------------
    function getDots() {
        var out = [];
        document.querySelectorAll('path.recharts-symbols').forEach(function (p) {
            var idx = parseInt(p.getAttribute('data-recharts-item-index'), 10);
            if (isNaN(idx)) return;
            out.push({
                el: p,
                idx: idx,
                id: p.getAttribute('id') || '',
                color: (p.getAttribute('color') || '').trim()
            });
        });
        return out;
    }
    function getRows() {
        var rows = [];
        document.querySelectorAll('div[role="button"][aria-label]').forEach(function (item) {
            var link = null;
            var links = item.querySelectorAll('a[href]');
            for (var i = 0; i < links.length; i++) {
                var h = links[i].getAttribute('href') || '';
                if (/^\/[^\/]+\/[^\/]+/.test(h)) { link = links[i]; break; }
            }
            if (!link) return;
            var url = link.getAttribute('href').substring(1);
            var name = item.getAttribute('aria-label') || '';
            var colorEl = item.querySelector('div[style*="background-color"]');
            var style = colorEl ? colorEl.getAttribute('style') : '';
            var m = style.match(/background-color:\s*([^;]+)/);
            var color = m ? m[1].trim() : '';
            var firstCell = item.querySelector('div');
            var rank = parseInt(firstCell ? (firstCell.textContent || '').trim() : '', 10);
            if (name && !isNaN(rank)) rows.push({ rank: rank, name: name, color: color, url: url });
        });
        return rows;
    }
    function clickShowMore(svg) {
        var node = svg;
        while (node && node !== document.body) {
            var btns = node.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
                if ((btns[i].textContent || '').trim() === 'Show more') {
                    btns[i].click();
                    log('clicked Show more');
                    return true;
                }
            }
            node = node.parentElement;
        }
        return false;
    }
    function buildMapping(dots, rows) {
        var byRank = {};
        rows.forEach(function (r) { byRank[r.rank] = r; });
        var mapping = new Map();
        dots.forEach(function (d) {
            var row = byRank[d.idx + 1];
            var name = null;
            if (row) {
                if (!row.color || !d.color || row.color === d.color) name = row.name;
                else log('color mismatch at idx', d.idx, row.name);
            }
            if (!name) {
                var cands = rows.filter(function (r) {
                    return d.id === r.url || (d.id.indexOf(r.url) === 0 && d.id.charAt(r.url.length) === '-');
                });
                for (var i = 0; i < cands.length; i++) {
                    if (!cands[i].color || !d.color || cands[i].color === d.color) { name = cands[i].name; break; }
                }
                if (!name && cands.length) name = cands[0].name;
            }
            if (name) mapping.set(d.el, name);
            else log('unmapped dot', d.id);
        });
        return mapping;
    }

    // ---------------- 标注层 ----------------
    function removeOverlay() {
        var ov = document.getElementById(OV_ID);
        if (ov) ov.remove();
        currentLabels = [];
    }
    function rectsOverlap(a, b) {
        return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
               Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    }
    function leaderPoints(entry) {
        var p = entry.p;
        var dx = p.x - entry.cx, dy = p.y - entry.cy;
        var len = Math.hypot(dx, dy) || 1;
        var ux = dx / len, uy = dy / len;
        var tx = Math.abs(ux) > 1e-6 ? (entry.lw / 2) / Math.abs(ux) : 1e9;
        var ty = Math.abs(uy) > 1e-6 ? (entry.lh / 2) / Math.abs(uy) : 1e9;
        var t0 = Math.min(tx, ty);
        return [entry.cx + ux * t0, entry.cy + uy * t0, p.x - ux * (p.r + 3), p.y - uy * (p.r + 3)];
    }
    function positionEntry(entry) {
        entry.text.setAttribute('x', entry.cx);
        entry.text.setAttribute('y', entry.cy + 4);
        entry.hit.setAttribute('x', entry.cx - entry.lw / 2);
        entry.hit.setAttribute('y', entry.cy - entry.lh / 2);
        var lp = leaderPoints(entry);
        entry.line.setAttribute('x1', lp[0]); entry.line.setAttribute('y1', lp[1]);
        entry.line.setAttribute('x2', lp[2]); entry.line.setAttribute('y2', lp[3]);
    }
    function attachInteractions(entry) {
        entry.g.style.cursor = 'move';
        entry.g.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            var sx = e.clientX, sy = e.clientY, ox = entry.cx, oy = entry.cy, moved = false;
            function mm(ev) {
                var dx = ev.clientX - sx, dy = ev.clientY - sy;
                if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
                entry.cx = ox + dx; entry.cy = oy + dy;
                positionEntry(entry);
            }
            function mu() {
                window.removeEventListener('mousemove', mm);
                window.removeEventListener('mouseup', mu);
                if (moved) {
                    customPos[entry.name] = [entry.cx / entry.W, entry.cy / entry.H];
                    saveStore();
                    log('label moved:', entry.name);
                }
            }
            window.addEventListener('mousemove', mm);
            window.addEventListener('mouseup', mu);
        });
        entry.g.addEventListener('dblclick', function (e) {
            e.preventDefault(); e.stopPropagation();
            hiddenNames[entry.name] = true;
            entry.g.style.display = 'none';
            entry.line.style.display = 'none';
            log('label hidden:', entry.name);
            saveStore();
        });
    }

    function drawOverlay(svg, dots, mapping) {
        var rect = svg.getBoundingClientRect();
        var W = Math.round(rect.width), H = Math.round(rect.height);
        if (W < 50 || H < 50) return;

        var pts = [];
        dots.forEach(function (d) {
            var name = mapping.get(d.el);
            if (!name || hiddenNames[name]) return;
            var dr = d.el.getBoundingClientRect();
            pts.push({
                x: dr.left - rect.left + dr.width / 2,
                y: dr.top - rect.top + dr.height / 2,
                r: Math.max(3, dr.width / 2),
                name: name
            });
        });
        if (!pts.length) { removeOverlay(); return; }

        var sig = JSON.stringify(pts.map(function (p) { return [Math.round(p.x), Math.round(p.y), p.name]; }));
        var old = document.getElementById(OV_ID);
        if (old && old.dataset.sig === sig && +old.dataset.w === W && +old.dataset.h === H) return;
        removeOverlay();

        var NS = 'http://www.w3.org/2000/svg';
        var ov = document.createElementNS(NS, 'svg');
        ov.setAttribute('id', OV_ID);
        ov.setAttribute('width', W); ov.setAttribute('height', H);
        ov.style.cssText = 'position:absolute;left:' + (rect.left + window.scrollX) + 'px;top:' + (rect.top + window.scrollY) +
            'px;width:' + W + 'px;height:' + H + 'px;pointer-events:none;z-index:80;overflow:visible;';
        ov.dataset.sig = sig; ov.dataset.w = W; ov.dataset.h = H;

        var dark = document.documentElement.classList.contains('dark');
        var textColor = dark ? '#e2e8f0' : '#0f172a';
        var haloColor = dark ? '#0b1220' : '#ffffff';
        var lineColor = dark ? '#94a3b8' : '#64748b';

        var defs = document.createElementNS(NS, 'defs');
        var marker = document.createElementNS(NS, 'marker');
        marker.setAttribute('id', 'orl-arrow'); marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6');
        marker.setAttribute('orient', 'auto-start-reverse');
        var mp = document.createElementNS(NS, 'path');
        mp.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); mp.setAttribute('fill', lineColor);
        marker.appendChild(mp); defs.appendChild(marker); ov.appendChild(defs);

        var placed = [];
        var dotRects = pts.map(function (p) { return { x: p.x - p.r - 4, y: p.y - p.r - 4, w: (p.r + 4) * 2, h: (p.r + 4) * 2 }; });

        currentLabels = [];
        pts.forEach(function (p) {
            var lw = Math.min(260, p.name.length * 6.2 + 10), lh = 16;
            var center = null;

            if (customPos[p.name]) {
                center = { cx: customPos[p.name][0] * W, cy: customPos[p.name][1] * H };
            } else {
                var best = null;
                var dists = [20, 32, 46, 62, 80];
                for (var di = 0; di < dists.length && !best; di++) {
                    var cands = [];
                    for (var s = 0; s < 16; s++) {
                        var ang = s * Math.PI / 8;
                        cands.push({ cx: p.x + Math.cos(ang) * dists[di], cy: p.y + Math.sin(ang) * dists[di], pen: 0 });
                    }
                    cands.forEach(function (c) {
                        var rc = { x: c.cx - lw / 2, y: c.cy - lh / 2, w: lw, h: lh };
                        var pen = 0;
                        placed.forEach(function (o) { pen += rectsOverlap(rc, o) * 2; });
                        dotRects.forEach(function (o) { pen += rectsOverlap(rc, o); });
                        if (rc.x < 0) pen += -rc.x * 10;
                        if (rc.y < 0) pen += -rc.y * 10;
                        if (rc.x + rc.w > W) pen += (rc.x + rc.w - W) * 10;
                        if (rc.y + rc.h > H) pen += (rc.y + rc.h - H) * 10;
                        c.pen = pen;
                    });
                    cands.sort(function (x, y) { return x.pen - y.pen; });
                    if (cands[0].pen <= 0.01 || cands[0].pen < 30 || di === dists.length - 1) best = cands[0];
                }
                center = best;
            }

            var entry = { name: p.name, p: p, lw: lw, lh: lh, cx: center.cx, cy: center.cy, W: W, H: H };
            placed.push({ x: entry.cx - lw / 2, y: entry.cy - lh / 2, w: lw, h: lh });

            var line = document.createElementNS(NS, 'line');
            line.setAttribute('stroke', lineColor); line.setAttribute('stroke-width', '1');
            line.setAttribute('marker-end', 'url(#orl-arrow)');
            line.setAttribute('pointer-events', 'none');
            ov.appendChild(line);
            entry.line = line;

            var g = document.createElementNS(NS, 'g');
            g.setAttribute('pointer-events', 'auto');
            var hit = document.createElementNS(NS, 'rect');
            hit.setAttribute('width', lw); hit.setAttribute('height', lh);
            hit.setAttribute('fill', 'transparent');
            hit.setAttribute('pointer-events', 'all');
            g.appendChild(hit);
            entry.hit = hit;

            var text = document.createElementNS(NS, 'text');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('font-size', '11');
            text.setAttribute('font-family', 'system-ui, sans-serif');
            text.setAttribute('fill', textColor);
            text.setAttribute('stroke', haloColor);
            text.setAttribute('stroke-width', '3');
            text.setAttribute('paint-order', 'stroke');
            text.setAttribute('pointer-events', 'none');
            text.textContent = p.name;
            g.appendChild(text);
            entry.text = text;

            ov.appendChild(g);
            entry.g = g;
            positionEntry(entry);
            attachInteractions(entry);
            currentLabels.push(entry);
        });

        document.body.appendChild(ov);
        log('overlay drawn, labels =', pts.length);
    }

    // ---------------- 重置按钮 ----------------
    function ensureResetBtn() {
        if (document.getElementById(BTN_ID)) return;
        var b = document.createElement('div');
        b.id = BTN_ID;
        b.textContent = 'ORL 显示全部标签';
        b.title = '恢复被双击隐藏的标签，并重置所有拖拽过的位置';
        b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;cursor:pointer;background:#111827;color:#f9fafb;' +
            'font:12px system-ui,sans-serif;padding:6px 10px;border-radius:6px;opacity:0.85;user-select:none;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
        b.addEventListener('click', function () {
            hiddenNames = {};
            customPos = {};
            try { localStorage.removeItem(STORE_KEY); } catch (e) {}
            removeOverlay();
            annotate();
            log('reset: show all labels');
        });
        document.body.appendChild(b);
    }

    // ---------------- 主流程 ----------------
    async function annotate() {
        if (busy) return;
        busy = true;
        try {
            var svg = document.querySelector('svg.recharts-surface');
            if (!svg) { removeOverlay(); return; }
            var dots = getDots();
            if (!dots.length) { removeOverlay(); return; }
            var rows = getRows();
            if (rows.length < dots.length) {
                if (clickShowMore(svg)) {
                    await sleep(800);
                    rows = getRows();
                }
            }
            var mapping = buildMapping(dots, rows);
            log('dots =', dots.length, ', rows =', rows.length, ', mapped =', mapping.size);
            drawOverlay(svg, dots, mapping);
        } catch (e) {
            log('annotate error:', e && e.stack ? e.stack : e);
        } finally {
            busy = false;
        }
    }
    function schedule(delay) {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(function () { pendingTimer = null; annotate(); }, delay || 400);
    }
    function boot() {
        loadStore();
        log('booted, version', VERSION);
        ensureResetBtn();
        setTimeout(autoPareto, 2000);
        var mo = new MutationObserver(function (muts) {
            var ov = document.getElementById(OV_ID);
            var relevant = false;
            for (var i = 0; i < muts.length; i++) {
                var t = muts[i].target;
                if (ov && (t === ov || ov.contains(t))) continue;
                relevant = true; break;
            }
            if (relevant) schedule(400);
        });
        mo.observe(document.body, { childList: true, subtree: true, attributes: true });
        window.addEventListener('resize', function () { schedule(300); });
        window.__orlRun = annotate;
        schedule(1500);
    }
    boot();
})();
