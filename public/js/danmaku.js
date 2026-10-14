/**
 * public/js/danmaku.js — 播放器弹幕层（round36 P0-1）
 *
 * 依赖：后端 /api/danmaku/*（弹弹play 开放 API 代理）。
 * 用法：视频打开时调用 window.Danmaku.start(匹配文件名)；关闭时 stop()。
 * 渲染：DOM 弹幕（lane 复用 + transform 动画），同步 video.currentTime。
 * 偏好存 localStorage（弹幕开关/透明度/速度/字号/屏蔽词，每设备独立）。
 */
(function () {
    'use strict';

    const LS_KEY = 'cvDanmakuPrefs';
    const prefs = Object.assign(
        { on: true, opacity: 0.85, speed: 1.0, fontSize: 18, blockWords: '' },
        JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    );
    function savePrefs() { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); }

    // ---- 状态 ----
    let video = null;
    let layer = null;
    let serverConfigured = false;   // 服务端是否配了 AppId/Secret
    let statusChecked = false;
    let comments = [];              // [{t,mode,color,text}] 已按 t 升序
    let cursor = 0;                 // 下一条待发射弹幕下标
    let lanes = [];                 // 每 lane 的占用到期时间
    let rafId = 0;
    let lastVideoTime = -1;
    let toggleBtn = null;

    function laneCount() {
        return Math.max(4, Math.floor(layer.clientHeight / (prefs.fontSize + 8)));
    }

    // ---- 状态查询（只查一次） ----
    async function ensureStatus() {
        if (statusChecked) return serverConfigured;
        try {
            const r = await fetch('/api/danmaku/status');
            const j = await r.json();
            serverConfigured = !!(j && j.code === 0 && j.data && j.data.configured);
        } catch (e) { serverConfigured = false; }
        statusChecked = true;
        return serverConfigured;
    }

    // ---- 加载弹幕 ----
    async function load(matchKey) {
        comments = []; cursor = 0;
        if (!matchKey || !prefs.on) return false;
        if (!(await ensureStatus())) return false;
        try {
            const m = await fetch('/api/danmaku/match', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: matchKey }),
            }).then((r) => r.json());
            if (m.code !== 0 || !m.data) return false;
            const c = await fetch(`/api/danmaku/comments?episodeId=${m.data.episodeId}`).then((r) => r.json());
            if (c.code !== 0) return false;
            const block = (prefs.blockWords || '').split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean);
            comments = (c.data.comments || []).filter((x) => !block.some((w) => x.text.includes(w)));
            cursor = 0;
            return comments.length > 0;
        } catch (e) {
            return false;
        }
    }

    // ---- 渲染 ----
    function fire(item) {
        // 找一条空闲 lane（右端不叠）
        const n = laneCount();
        const now = performance.now();
        let lane = -1;
        for (let i = 0; i < n; i++) {
            if (!lanes[i] || lanes[i] < now) { lane = i; break; }
        }
        if (lane < 0) return; // 全满，丢弃（保流畅）
        const el = document.createElement('span');
        el.className = 'danmaku-item';
        el.textContent = item.text;
        el.style.fontSize = prefs.fontSize + 'px';
        el.style.opacity = prefs.opacity;
        el.style.top = (lane * (prefs.fontSize + 8) + 4) + 'px';
        // 弹弹play 颜色是 0xRRGGBB 整数
        el.style.color = '#' + (item.color || 0xffffff).toString(16).padStart(6, '0');
        if (item.mode === 4) { // 底部
            el.classList.add('danmaku-bottom');
            el.style.bottom = '12%';
            el.style.top = 'auto';
            layer.appendChild(el);
            const life = 4500 / prefs.speed;
            lanes[lane] = now + 600;
            setTimeout(() => el.remove(), life);
            return;
        }
        if (item.mode === 5) { // 顶部
            el.classList.add('danmaku-top');
            el.style.top = '8%';
            layer.appendChild(el);
            lanes[lane] = now + 600;
            setTimeout(() => el.remove(), 4500 / prefs.speed);
            return;
        }
        // 滚动（默认）：CSS transition 从右到左
        layer.appendChild(el);
        const w = el.offsetWidth;
        const dist = layer.clientWidth + w;
        const dur = Math.max(4000, 9000 / prefs.speed) * (0.9 + Math.random() * 0.2);
        el.style.transform = `translateX(${layer.clientWidth}px)`;
        el.style.transition = `transform ${dur}ms linear`;
        lanes[lane] = now + Math.max(900, (dist / dur) * 1000 * 0.75);
        requestAnimationFrame(() => { el.style.transform = `translateX(-${w}px)`; });
        setTimeout(() => el.remove(), dur + 200);
    }

    function tick() {
        if (!video || !comments.length || video.paused || video.seeking) {
            rafId = requestAnimationFrame(tick);
            return;
        }
        const t = video.currentTime * 1000;
        // seek 回退：重置 cursor
        if (t < lastVideoTime - 800) cursor = 0;
        lastVideoTime = t;
        while (cursor < comments.length && comments[cursor].t <= t) {
            const item = comments[cursor];
            if (t - item.t < 1200) fire(item); // 只发 1.2s 内的，seek 跳过的不补发
            cursor++;
        }
        rafId = requestAnimationFrame(tick);
    }

    // ---- 生命周期 ----
    async function start(matchKey, videoEl) {
        stop();
        video = videoEl || document.getElementById('videoPlayer');
        layer = document.getElementById('danmakuLayer');
        if (!video || !layer) return;
        setBtn(true);
        const ok = await load(matchKey);
        setBtn(ok ? 'on' : 'empty');
        if (!ok) return;
        lanes = new Array(Math.max(4, laneCount())).fill(0);
        lastVideoTime = -1;
        rafId = requestAnimationFrame(tick);
    }

    function stop() {
        cancelAnimationFrame(rafId);
        rafId = 0;
        comments = []; cursor = 0;
        if (layer) layer.innerHTML = '';
        video = null;
        setBtn(false);
    }

    function setBtn(state) {
        // state: true=加载中/on, false=停, 'on'=有弹幕, 'empty'=没匹配到
        if (!toggleBtn) return;
        toggleBtn.classList.toggle('danmaku-active', state === true || state === 'on');
        toggleBtn.title = state === 'empty' ? '本片没有匹配到弹幕' : state === 'on' ? '弹幕已开启' : '';
    }

    // ---- 设置面板 ----
    function showSettings() {
        const old = document.getElementById('danmakuSettings');
        if (old) { old.remove(); return; }
        const panel = document.createElement('div');
        panel.id = 'danmakuSettings';
        panel.style.cssText = 'position:absolute;right:14px;bottom:60px;z-index:10;background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:14px;width:250px;box-shadow:0 8px 30px rgba(0,0,0,.35);';
        panel.innerHTML = `
            <div style="font-weight:700;font-size:13px;margin-bottom:10px;">💬 弹幕设置</div>
            <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:8px;"><input type="checkbox" id="dmOn" ${prefs.on ? 'checked' : ''}> 启用弹幕</label>
            <label style="font-size:12px;display:block;margin-bottom:4px;">透明度 ${Math.round(prefs.opacity * 100)}%</label>
            <input type="range" id="dmOpacity" min="0.2" max="1" step="0.05" value="${prefs.opacity}" style="width:100%;">
            <label style="font-size:12px;display:block;margin:8px 0 4px;">速度 ${prefs.speed.toFixed(1)}x</label>
            <input type="range" id="dmSpeed" min="0.5" max="2" step="0.1" value="${prefs.speed}" style="width:100%;">
            <label style="font-size:12px;display:block;margin:8px 0 4px;">字号 ${prefs.fontSize}px</label>
            <input type="range" id="dmFontSize" min="12" max="32" step="1" value="${prefs.fontSize}" style="width:100%;">
            <label style="font-size:12px;display:block;margin:8px 0 4px;">屏蔽词（逗号分隔）</label>
            <input type="text" id="dmBlock" value="${(prefs.blockWords || '').replace(/"/g, '&quot;')}" style="width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px;">
            <div style="font-size:11px;color:var(--text-muted);margin-top:10px;">弹幕源：弹弹play（设置页可配 AppId）</div>`;
        document.querySelector('.player-stage').appendChild(panel);
        panel.querySelector('#dmOn').addEventListener('change', (e) => { prefs.on = e.target.checked; savePrefs(); if (!prefs.on) stop(); });
        panel.querySelector('#dmOpacity').addEventListener('input', (e) => { prefs.opacity = +e.target.value; savePrefs(); });
        panel.querySelector('#dmSpeed').addEventListener('input', (e) => { prefs.speed = +e.target.value; savePrefs(); });
        panel.querySelector('#dmFontSize').addEventListener('input', (e) => { prefs.fontSize = +e.target.value; savePrefs(); });
        panel.querySelector('#dmBlock').addEventListener('change', (e) => { prefs.blockWords = e.target.value; savePrefs(); });
    }

    function init() {
        layer = document.getElementById('danmakuLayer');
        toggleBtn = document.getElementById('danmakuToggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showSettings();
            });
        }
        ensureStatus();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.Danmaku = { start, stop, prefs };
})();
