/*
 * Stremio v4.4 — VIDAA layer
 * ---------------------------------------------------------------------------
 * Loaded BEFORE Stremio's own blob.js. Everything here is a port of the
 * VIDAA adaptations from NoobyGains/stremio-vidaa-tv (written for the v5
 * Theater build) onto the v4.4 AngularJS shell, which — unlike v5 — needs no
 * WebAssembly and therefore runs on VIDAA's old Chromium (no wasm externref).
 *
 * Written in ES5 on purpose: the VIDAA browser engine is old.
 *
 *   runtime      logger / store / poll / route helpers         (kernel/runtime)
 *   keys         one capture-phase remote-key dispatcher        (kernel/keys)
 *   back         VIDAA Back (461/10009) -> app back; exit at root
 *   fkey         swallow F / F11 (fullscreen crashes VIDAA)      (platform/fkey-suppress)
 *   keyboard     VIDAA on-screen keyboard -> input events (search fix)
 *                                                                (platform/keyboard-fix)
 *   device       trusted-domain registration + caps             (kernel/device)
 *   exit         Hisense_Exit wrapper                           (platform/exit-button)
 *   media keys   play/pause/stop/ff/rw on the remote
 *   channel seek CH+/CH- = +/-60s                               (player/channel-seek)
 *   embedded     container subtitle + audio tracks picker, with the VIDAA
 *                textTracks "show-then-disable" quirk and cue positioning
 *                                                                (video/VidaaVideo)
 *   sub delay    embedded subtitle delay                        (subtitles/embedded-delay)
 *   speed/vol    persist playback volume                        (player/speed-volume-persist)
 *   info         codec/resolution overlay on Blue               (player/resolution-indicator)
 */
(function () {
    'use strict';

    var VERSION = '55d4490d';
    window.__VIDAA_V4__ = VERSION;

    /* ================================================================ runtime */
    var PREFIX = '[vidaa] ';
    function logger(tag) {
        var f = function () {
            try {
                var a = Array.prototype.slice.call(arguments);
                a.unshift(PREFIX + tag + ':');
                console.log.apply(console, a);
            } catch (e) {}
        };
        f.error = function () {
            try {
                var a = Array.prototype.slice.call(arguments);
                a.unshift(PREFIX + tag + ':');
                console.error.apply(console, a);
            } catch (e) {}
        };
        return f;
    }
    var store = {
        get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
        set: function (k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} },
        getBool: function (k, d) { var v = store.get(k, null); return v === null ? d : v === 'true'; }
    };
    function hash() { return window.location.hash || ''; }
    function inPlayer() { return hash().indexOf('#/player') === 0; }
    function atRoot() {
        var h = hash().replace(/\?.*$/, '');
        return h === '' || h === '#' || h === '#/' || h === '#/board' || h.indexOf('#/intro') === 0;
    }
    function isTyping(e) {
        var t = e && e.target;
        var tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
        return tag === 'input' || tag === 'textarea' || (t && t.isContentEditable);
    }
    function video() {
        var vids = document.getElementsByTagName('video');
        for (var i = 0; i < vids.length; i++) { if (vids[i].src || vids[i].currentSrc) return vids[i]; }
        return vids[0] || null;
    }
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    var toastEl = null, toastTimer = null;
    function toast(msg, ms) {
        if (!document.body) return;
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'vidaa-toast';
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, ms || 1500);
    }
    window.__vidaaRuntime = { logger: logger, store: store, inPlayer: inPlayer, toast: toast, video: video };

    /* =================================================================== keys
     * One capture-phase listener on WINDOW (runs before Stremio's own
     * document/element listeners). Handlers are registered with a priority;
     * a handler returning false or registered with suppress:true consumes
     * the key. Same contract as Nooby's __vidaaKeys.
     */
    var CODES = {
        red: 403, green: 404, yellow: 405, blue: 406, info: 457,
        channelUp: 427, channelDown: 428,
        back: [461, 10009],
        play: 415, pause: 19, playPause: [10252, 179], stop: 413,
        ff: 417, rw: 412,
        up: 38, down: 40, left: 37, right: 39, enter: 13,
        f: 70, f11: 122,
        subtitle: [460, 10221], audio: [10222]
    };
    var regs = [], seq = 0;
    function namesFor(code) {
        var out = [];
        for (var n in CODES) {
            if (!CODES.hasOwnProperty(n)) continue;
            var c = CODES[n];
            if (Object.prototype.toString.call(c) === '[object Array]' ? c.indexOf(code) !== -1 : c === code) out.push(n);
        }
        return out;
    }
    function onKey(spec, handler, opts) {
        opts = opts || {};
        var names = Object.prototype.toString.call(spec) === '[object Array]' ? spec.slice() : [spec];
        var r = { names: names, handler: handler, opts: opts, seq: ++seq };
        regs.push(r);
        return r;
    }
    window.addEventListener('keydown', function (e) {
        var names = namesFor(e.keyCode);
        if (!names.length) return;
        var firing = [];
        for (var i = 0; i < regs.length; i++) {
            var r = regs[i], hit = false;
            for (var j = 0; j < names.length; j++) { if (r.names.indexOf(names[j]) !== -1 || r.names.indexOf('*') !== -1) { hit = true; break; } }
            if (!hit) continue;
            if (r.opts.route === 'player' && !inPlayer()) continue;
            if (r.opts.route === 'nonplayer' && inPlayer()) continue;
            if (r.opts.when) { try { if (!r.opts.when(e)) continue; } catch (err) { continue; } }
            firing.push(r);
        }
        firing.sort(function (a, b) { return (b.opts.priority || 0) - (a.opts.priority || 0) || a.seq - b.seq; });
        for (var k = 0; k < firing.length; k++) {
            var ret;
            try { ret = firing[k].handler(e); } catch (err) { logger('keys').error(err && err.message); }
            if (ret === false || firing[k].opts.suppress) {
                try { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (err2) {}
                return;
            }
        }
    }, true);
    window.__vidaaKeys = { on: onKey, codes: CODES };

    /* Re-dispatch a key as a different keyCode so Stremio's own shortcut
     * table (which knows Escape/Backspace/Space but not VIDAA codes) acts
     * on it. keyCode/which are read-only on real events, so define them. */
    function synthKey(code, key) {
        var target = document.activeElement || document.body || document;
        var ev;
        try { ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: key }); }
        catch (e) { ev = document.createEvent('Event'); ev.initEvent('keydown', true, true); }
        try {
            Object.defineProperty(ev, 'keyCode', { get: function () { return code; } });
            Object.defineProperty(ev, 'which', { get: function () { return code; } });
        } catch (e) {}
        target.dispatchEvent(ev);
        var up;
        try { up = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: key }); }
        catch (e) { up = document.createEvent('Event'); up.initEvent('keyup', true, true); }
        try {
            Object.defineProperty(up, 'keyCode', { get: function () { return code; } });
            Object.defineProperty(up, 'which', { get: function () { return code; } });
        } catch (e) {}
        target.dispatchEvent(up);
    }

    /* =================================================================== exit */
    function exitApp() {
        logger('exit')('exiting app');
        try { if (typeof Hisense_Exit === 'function') { Hisense_Exit(); return; } } catch (e) {}
        try { if (typeof Hisense_CloseApp === 'function') { Hisense_CloseApp(); return; } } catch (e) {}
        try { window.close(); } catch (e) {}
    }
    window.__exitApp = exitApp;

    /* =================================================================== back
     * VIDAA Back sends 461 (some firmwares 10009). Stremio v4 treats
     * Backspace/Escape as "back", so translate. At the root screen, a
     * second Back within 2s exits the app (first one shows a hint), so you
     * never get stuck on a blank history entry.
     */
    var lastRootBack = 0;
    onKey('back', function (e) {
        if (picker.isOpen()) { picker.close(); return false; }
        if (atRoot() && !inPlayer()) {
            var now = Date.now();
            if (now - lastRootBack < 2000) { exitApp(); return false; }
            lastRootBack = now;
            toast('Press Back again to exit', 2000);
            return false;
        }
        synthKey(27, 'Escape');
        return false;
    }, { priority: 800 });

    /* =================================================================== fkey */
    onKey(['f', 'f11'], function () { logger('fkey')('suppressed fullscreen key'); },
        { priority: 900, suppress: true, when: function (e) { return !isTyping(e); } });

    /* ========================================================== media keys */
    function vplay() { var v = video(); if (v) { try { v.play(); } catch (e) {} } }
    function vpause() { var v = video(); if (v) { try { v.pause(); } catch (e) {} } }
    function seekBy(sec, label) {
        var v = video();
        if (!v || !isFinite(v.currentTime)) return;
        var t = v.currentTime + sec;
        if (isFinite(v.duration)) t = Math.min(t, v.duration - 1);
        v.currentTime = Math.max(0, t);
        toast(label || ((sec > 0 ? '+' : '') + sec + 's'));
    }
    onKey('play', vplay, { route: 'player', suppress: true });
    onKey('pause', vpause, { route: 'player', suppress: true });
    onKey('playPause', function () { var v = video(); if (v) { v.paused ? vplay() : vpause(); } }, { route: 'player', suppress: true });
    onKey('stop', function () { vpause(); synthKey(27, 'Escape'); }, { route: 'player', suppress: true });
    onKey('ff', function () { seekBy(30); }, { route: 'player', suppress: true });
    onKey('rw', function () { seekBy(-30); }, { route: 'player', suppress: true });
    onKey('channelUp', function () { seekBy(60); }, { route: 'player', suppress: true });
    onKey('channelDown', function () { seekBy(-60); }, { route: 'player', suppress: true });

    /* ============================================================ keyboard
     * The VIDAA system keyboard writes input.value directly and fires no
     * DOM events, so Angular's ng-model never sees the text and search
     * stays empty. (1) wrap the value setter to emit 'input', (2) poll the
     * search box as a fallback, (3) submit the search form once typing settles.
     */
    (function () {
        try {
            var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (desc && desc.set) {
                var origSet = desc.set, origGet = desc.get, guard = false;
                Object.defineProperty(HTMLInputElement.prototype, 'value', {
                    get: origGet,
                    set: function (v) {
                        var old = origGet.call(this);
                        origSet.call(this, v);
                        if (v !== old && !guard) {
                            guard = true;
                            try { var ev = document.createEvent('Event'); ev.initEvent('input', true, true); this.dispatchEvent(ev); } catch (e) {}
                            guard = false;
                        }
                    },
                    configurable: true
                });
            }
        } catch (e) {}

        var prev = '', lastPushed = '', submitTimer = null;
        setInterval(function () {
            try {
                var el = document.activeElement;
                if (!el || el.tagName !== 'INPUT') {
                    el = document.querySelector('input[ng-model="searchQuery"]') || document.querySelector('#global-search-field') || null;
                }
                if (!el || el.tagName !== 'INPUT') return;
                var v = el.value || '';
                if (v === prev) return;
                prev = v;
                try {
                    var a = document.createEvent('Event'); a.initEvent('input', true, true); el.dispatchEvent(a);
                    var c = document.createEvent('Event'); c.initEvent('change', true, true); el.dispatchEvent(c);
                } catch (e) {}
                // v4 only searches on form submit (ng-submit="performSearch(..)"),
                // which the VIDAA keyboard never sends. Once typing settles,
                // submit the form exactly like pressing Enter would.
                var isSearch = el.id === 'global-search-field' || el.getAttribute('ng-model') === 'searchQuery';
                if (isSearch && v.length > 1 && v !== lastPushed) {
                    clearTimeout(submitTimer);
                    submitTimer = setTimeout(function () {
                        if ((el.value || '') !== v || v === lastPushed) return;
                        lastPushed = v;
                        var form = el.form || document.getElementById('search-bar');
                        if (!form) return;
                        try { var s = document.createEvent('Event'); s.initEvent('submit', true, true); form.dispatchEvent(s); } catch (e) {}
                    }, 900);
                }
            } catch (e) {}
        }, 300);
    })();

    /* ============================================================== device */
    (function () {
        var log = logger('device');
        try { Hisense_GetOSVersion(); } catch (e) { return; }
        window.__VIDAA_DEVICE__ = true;
        try {
            var host = window.location.hostname;
            var domains = Hisense_GetInsecureDomain();
            if (Object.prototype.toString.call(domains) !== '[object Array]') domains = [];
            if (host && domains.indexOf(host) === -1) log('register domain', host, Hisense_AddInsecureDomain(host));
        } catch (e) { log('AddInsecureDomain unavailable', e && e.message); }
        var caps = window.__VIDAA_CAPS__ = {};
        try { caps.model = Hisense_GetModelName(); } catch (e) {}
        try { caps.firmware = Hisense_GetFirmWareVersion(); } catch (e) {}
        try { caps.osVersion = Hisense_GetOSVersion(); } catch (e) {}
        try { caps.chipset = Hisense_GetChipSetName(); } catch (e) {}
        try { caps.hdrInfo = Hisense_GetSupportForHDRInfo(); } catch (e) {}
        try { caps.panelRes = Hisense_GetPanelResolution(); } catch (e) {}
        log('caps', JSON.stringify(caps));
    })();

    /* ====================================================== embedded tracks
     * VIDAA's native player exposes the subtitle/audio tracks INSIDE the
     * file (MKV/MP4) on video.textTracks / video.audioTracks — no streaming
     * server needed. Stremio v4's menu only lists addon subtitles, so this
     * adds a picker (Red = subtitles, Green = audio) and auto-selects your
     * last used subtitle language.
     *
     * VIDAA quirk (from Nooby's VidaaVideo): cues are not populated until a
     * track has been 'showing' once, so on addtrack we flash the first track
     * to 'showing' and back to 'disabled' before reading the list.
     */
    var SUB_LANG_KEY = 'vidaa_v4_sub_lang';      // '' = off
    var SUB_DELAY_KEY = 'vidaa_v4_sub_delay';    // ms
    var VOLUME_KEY = 'vidaa_v4_volume';

    function realSubTracks(v) {
        var out = [];
        if (!v || !v.textTracks) return out;
        for (var i = 0; i < v.textTracks.length; i++) {
            var t = v.textTracks[i];
            if (t.kind === 'metadata') continue;           // hls.js id3 track
            if (t.label === 'vidaa-hidden') continue;
            out.push({ index: i, track: t });
        }
        return out;
    }
    function audioTracks(v) {
        var out = [];
        if (!v || !v.audioTracks) return out;
        for (var i = 0; i < v.audioTracks.length; i++) out.push({ index: i, track: v.audioTracks[i] });
        return out;
    }
    function trackName(t, i, kind) {
        var lang = t.language || '';
        var label = t.label || '';
        var name = label && label !== lang ? label + (lang ? ' (' + lang + ')' : '') : (lang || (kind + ' ' + (i + 1)));
        return name;
    }
    function positionCues(track) {
        try {
            var cues = track.cues;
            if (!cues) return;
            for (var i = 0; i < cues.length; i++) {
                var c = cues[i];
                if (c.__vidaaPos) continue;
                c.__vidaaPos = true;
                try { c.snapToLines = false; c.line = 88; } catch (e) {}
            }
        } catch (e) {}
    }
    function applyDelay(track) {
        var target = parseInt(store.get(SUB_DELAY_KEY, '0'), 10) || 0;
        try {
            var cues = track.cues;
            if (!cues) return;
            for (var i = 0; i < cues.length; i++) {
                var c = cues[i];
                var prev = typeof c.__vidaaDelay === 'number' ? c.__vidaaDelay : 0;
                if (prev === target) continue;
                var d = (target - prev) / 1000;
                c.startTime = Math.max(0, c.startTime + d);
                c.endTime = Math.max(c.startTime, c.endTime + d);
                c.__vidaaDelay = target;
            }
        } catch (e) {}
    }
    function selectSub(v, index) {
        var subs = realSubTracks(v);
        for (var i = 0; i < subs.length; i++) subs[i].track.mode = 'disabled';
        if (index === -1) { store.set(SUB_LANG_KEY, ''); toast('Subtitles off'); return; }
        for (var j = 0; j < subs.length; j++) {
            if (subs[j].index === index) {
                var t = subs[j].track;
                t.mode = 'showing';
                positionCues(t); applyDelay(t);
                store.set(SUB_LANG_KEY, t.language || t.label || '');
                toast('Subtitles: ' + trackName(t, j, 'Track'));
            }
        }
    }
    function selectAudio(v, index) {
        var a = audioTracks(v);
        for (var i = 0; i < a.length; i++) a[i].track.enabled = (a[i].index === index);
        for (var j = 0; j < a.length; j++) if (a[j].index === index) toast('Audio: ' + trackName(a[j].track, j, 'Audio'));
    }
    function hookVideo(v) {
        if (!v || v.__vidaaHooked) return;
        v.__vidaaHooked = true;
        var log = logger('tracks');
        // persist volume
        try {
            var vol = parseFloat(store.get(VOLUME_KEY, ''));
            if (isFinite(vol) && vol >= 0 && vol <= 1) v.volume = vol;
            v.addEventListener('volumechange', function () { store.set(VOLUME_KEY, v.volume); });
        } catch (e) {}
        if (!v.textTracks) return;
        var autoDone = false;
        function onAdd() {
            setTimeout(function () {
                var subs = realSubTracks(v);
                if (!subs.length) return;
                // VIDAA quirk: flash first track to load cues
                try { subs[0].track.mode = 'showing'; } catch (e) {}
                setTimeout(function () {
                    var want = store.get(SUB_LANG_KEY, null);
                    var chosen = -1;
                    if (want) {
                        for (var i = 0; i < subs.length; i++) {
                            var t = subs[i].track;
                            if ((t.language || t.label || '') === want) { chosen = subs[i].index; break; }
                        }
                    }
                    for (var k = 0; k < subs.length; k++) subs[k].track.mode = 'disabled';
                    if (chosen !== -1 && !autoDone) { autoDone = true; selectSub(v, chosen); }
                    log(subs.length + ' embedded subtitle track(s)', chosen !== -1 ? '(auto: ' + want + ')' : '');
                    if (!autoDone && subs.length) toast(subs.length + ' embedded subtitle track(s) — press Red', 3000);
                }, 50);
            }, 0);
        }
        try { v.textTracks.addEventListener('addtrack', onAdd); } catch (e) { v.textTracks.onaddtrack = onAdd; }
        if (v.textTracks.length) onAdd();
        // keep cues positioned/delayed as they stream in
        try {
            v.textTracks.addEventListener('change', function () {
                var subs = realSubTracks(v);
                for (var i = 0; i < subs.length; i++) {
                    if (subs[i].track.mode === 'showing') {
                        (function (t) {
                            if (!t.__vidaaCue) { t.__vidaaCue = true; t.addEventListener('cuechange', function () { positionCues(t); applyDelay(t); }); }
                            positionCues(t); applyDelay(t);
                        })(subs[i].track);
                    }
                }
            });
        } catch (e) {}
        v.addEventListener('emptied', function () { autoDone = false; });
    }
    setInterval(function () { if (inPlayer()) { var v = video(); if (v) hookVideo(v); } }, 1000);

    /* ---- picker overlay ----
     * Works with the D-pad (keys captured while open) AND with the VIDAA
     * pointer: in the TV Browser the arrow keys move a cursor and never
     * reach the page, so every row is clickable, there is a close (X)
     * button, the opening colour key toggles it shut, and it auto-closes
     * after 15s without input so it can never get stuck on screen. */
    var picker = (function () {
        var el = null, items = [], idx = 0, open = false, kind = '', title = '', idleTimer = null;
        var IDLE_MS = 15000;
        function bumpIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(close, IDLE_MS); }
        function render() {
            var html = '<div class="vp-head"><div class="vp-title">' + esc(title) + '</div>' +
                '<div class="vp-close" data-act="close">&#10005;</div></div>';
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                html += '<div class="vp-item' + (i === idx ? ' vp-focus' : '') + (it.active ? ' vp-active' : '') + '" data-i="' + i + '">';
                if (it.adjust) {
                    html += '<span class="vp-btn" data-i="' + i + '" data-dir="-1">&minus;</span>' +
                        '<span class="vp-label">' + esc(it.label) + '</span>' +
                        '<span class="vp-btn" data-i="' + i + '" data-dir="1">+</span>';
                } else {
                    html += (it.active ? '&#10003; ' : '') + esc(it.label);
                }
                html += '</div>';
            }
            html += '<div class="vp-hint">&#8597; choose &nbsp; OK select &nbsp; Back / same colour key closes</div>';
            el.innerHTML = html;
        }
        function activate(i) {
            var it = items[i];
            if (!it || it.adjust) return;
            close();
            if (it.run) it.run();
        }
        function onClick(e) {
            var t = e.target;
            while (t && t !== el && !t.getAttribute('data-i') && !t.getAttribute('data-act')) t = t.parentNode;
            if (!t || t === el) return;
            e.preventDefault(); e.stopPropagation();
            if (t.getAttribute('data-act') === 'close') { close(); return; }
            var i = parseInt(t.getAttribute('data-i'), 10);
            var dir = t.getAttribute('data-dir');
            idx = i;
            if (dir && items[i] && items[i].adjust) { items[i].adjust(parseInt(dir, 10)); render(); bumpIdle(); return; }
            activate(i);
        }
        function show(k, t, list) {
            kind = k; title = t; items = list; idx = 0;
            for (var i = 0; i < items.length; i++) if (items[i].active) { idx = i; break; }
            if (!el) {
                el = document.createElement('div');
                el.id = 'vidaa-picker';
                el.addEventListener('click', onClick, true);
                // keep pointer clicks from reaching the player underneath
                el.addEventListener('mousedown', function (e) { e.stopPropagation(); }, true);
                document.body.appendChild(el);
            }
            render();
            el.style.display = 'block';
            open = true;
            bumpIdle();
        }
        function close() { open = false; kind = ''; clearTimeout(idleTimer); if (el) el.style.display = 'none'; }
        onKey(['up', 'down', 'enter', 'left', 'right'], function (e) {
            bumpIdle();
            if (e.keyCode === 38) idx = (idx - 1 + items.length) % items.length;
            else if (e.keyCode === 40) idx = (idx + 1) % items.length;
            else if (e.keyCode === 13) { activate(idx); return false; }
            else if (e.keyCode === 37 || e.keyCode === 39) { var cur = items[idx]; if (cur && cur.adjust) cur.adjust(e.keyCode === 39 ? 1 : -1); }
            render();
            return false;
        }, { priority: 1000, when: function () { return open; } });
        return { show: show, close: close, isOpen: function () { return open; }, kind: function () { return kind; } };
    })();

    function openSubPicker() {
        var v = video();
        if (!v) { toast('No video'); return; }
        var subs = realSubTracks(v);
        var list = [];
        var anyOn = false;
        for (var i = 0; i < subs.length; i++) {
            (function (s, n) {
                var on = s.track.mode === 'showing'; if (on) anyOn = true;
                list.push({ label: trackName(s.track, n, 'Track'), active: on, run: function () { selectSub(v, s.index); } });
            })(subs[i], i);
        }
        list.unshift({ label: 'Off', active: !anyOn, run: function () { selectSub(v, -1); } });
        var delayItem = {
            label: '', active: false,
            adjust: function (dir) {
                var d = (parseInt(store.get(SUB_DELAY_KEY, '0'), 10) || 0) + dir * 250;
                d = Math.max(-5000, Math.min(5000, d));
                store.set(SUB_DELAY_KEY, d);
                var s = realSubTracks(v);
                for (var k = 0; k < s.length; k++) applyDelay(s[k].track);
                delayItem.label = 'Delay ' + (d > 0 ? '+' : '') + d + ' ms';
            }
        };
        var d0 = parseInt(store.get(SUB_DELAY_KEY, '0'), 10) || 0;
        delayItem.label = 'Delay ' + (d0 > 0 ? '+' : '') + d0 + ' ms';
        list.push(delayItem);
        picker.show('subs', subs.length ? 'Embedded subtitles' : 'No embedded subtitles in this file', list);
    }
    function openAudioPicker() {
        var v = video();
        if (!v) { toast('No video'); return; }
        var a = audioTracks(v);
        if (a.length < 2) { toast(a.length ? 'Only one audio track' : 'No selectable audio tracks'); return; }
        var list = [];
        for (var i = 0; i < a.length; i++) {
            (function (t, n) { list.push({ label: trackName(t.track, n, 'Audio'), active: !!t.track.enabled, run: function () { selectAudio(v, t.index); } }); })(a[i], i);
        }
        picker.show('audio', 'Audio track', list);
    }
    // the same colour key toggles its picker shut (works even when Back/arrows are eaten by cursor mode)
    onKey(['red', 'subtitle'], function () {
        if (picker.isOpen() && picker.kind() === 'subs') { picker.close(); return; }
        openSubPicker();
    }, { route: 'player', suppress: true });
    onKey(['green', 'audio'], function () {
        if (picker.isOpen() && picker.kind() === 'audio') { picker.close(); return; }
        openAudioPicker();
    }, { route: 'player', suppress: true });
    // OK on the remote = play/pause in the player (v4 only bound Space)
    onKey('enter', function () {
        var v = video();
        if (!v) return;
        v.paused ? vplay() : vpause();
        toast(v.paused ? 'Paused' : 'Playing', 900);
        return false;
    }, { route: 'player', priority: 100, when: function (e) { return !picker.isOpen() && !isTyping(e); } });
    onKey('yellow', function () { var v = video(); if (v) selectSub(v, -1); }, { route: 'player', suppress: true });

    /* ================================================================ info */
    var infoEl = null;
    function toggleInfo() {
        if (infoEl) { infoEl.parentNode && infoEl.parentNode.removeChild(infoEl); infoEl = null; return; }
        var v = video();
        var rows = [];
        if (v) {
            rows.push(['Resolution', (v.videoWidth || '?') + ' × ' + (v.videoHeight || '?')]);
            rows.push(['Position', Math.floor(v.currentTime || 0) + 's / ' + (isFinite(v.duration) ? Math.floor(v.duration) + 's' : '?')]);
            var b = 0; try { if (v.buffered.length) b = v.buffered.end(v.buffered.length - 1) - v.currentTime; } catch (e) {}
            rows.push(['Buffered ahead', Math.max(0, Math.round(b)) + 's']);
            rows.push(['Subtitle tracks', realSubTracks(v).length]);
            rows.push(['Audio tracks', audioTracks(v).length]);
            var src = v.currentSrc || v.src || '';
            rows.push(['Host', src.replace(/^https?:\/\//, '').split('/')[0]]);
        } else rows.push(['Video', 'none']);
        var caps = window.__VIDAA_CAPS__ || {};
        if (caps.model) rows.push(['TV', caps.model]);
        rows.push(['Layer', 'vidaa-v4 ' + VERSION]);
        var html = '<div class="vp-title">Stream info</div>';
        for (var i = 0; i < rows.length; i++) html += '<div class="vi-row"><span>' + esc(rows[i][0]) + '</span><b>' + esc(rows[i][1]) + '</b></div>';
        infoEl = document.createElement('div');
        infoEl.id = 'vidaa-info';
        infoEl.innerHTML = html;
        document.body.appendChild(infoEl);
        setTimeout(function () { if (infoEl) { infoEl.parentNode && infoEl.parentNode.removeChild(infoEl); infoEl = null; } }, 8000);
    }
    onKey(['blue', 'info'], toggleInfo, { suppress: true });

    logger('boot')('VIDAA layer ' + VERSION + ' loaded');
})();
