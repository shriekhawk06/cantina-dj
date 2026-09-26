/* Cantina DJ — shared frontend helpers (vanilla JS, no dependencies). */
(function () {
  'use strict';

  /** Escape HTML to avoid injection from user-supplied strings. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtMs(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  /* Inline SVG icons (no emoji in UI). 24x24, stroke=currentColor. */
  const I = (inner) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const icons = {
    play: I('<polygon points="6 4 20 12 6 20" fill="currentColor" stroke="none"/>'),
    pause: I('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>'),
    skip: I('<polygon points="5 4 15 12 5 20" fill="currentColor" stroke="none"/><line x1="17" y1="5" x2="17" y2="19"/>'),
    plus: I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    x: I('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
    ban: I('<circle cx="12" cy="12" r="9"/><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/>'),
    up: I('<polyline points="6 15 12 9 18 15"/>'),
    down: I('<polyline points="6 9 12 15 18 9"/>'),
    top: I('<polyline points="6 14 12 8 18 14"/><line x1="5" y1="19" x2="19" y2="19"/>'),
    bolt: I('<polygon points="13 2 4 14 11 14 10 22 20 9 13 9" fill="currentColor" stroke="none"/>'),
    star: I('<polygon points="12 2 15 9 22 9 16.5 13.5 18.5 21 12 16.5 5.5 21 7.5 13.5 2 9 9 9"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>'),
    link: I('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'),
    tv: I('<rect x="2" y="5" width="20" height="13" rx="2"/><polyline points="8 21 16 21 12 18"/>'),
    msg: I('<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/>'),
    music: I('<path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>'),
  };

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...(opts || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  /** Persistent guest identity per browser (random UUID in localStorage). */
  function guestId() {
    let id = null;
    try { id = localStorage.getItem('cantina_guest_id'); } catch { /* private mode */ }
    if (!id) {
      id = 'g_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
        : Math.random().toString(36).slice(2, 18));
      try { localStorage.setItem('cantina_guest_id', id); } catch { /* ignore */ }
    }
    return id;
  }

  function roomCode() {
    const q = new URLSearchParams(location.search).get('code');
    if (q) return q.toUpperCase();
    const m = location.pathname.match(/\/tv\/([A-Za-z0-9]+)/i);
    return m ? m[1].toUpperCase() : '';
  }

  /**
   * WebSocket room connection with auto-reconnect.
   * onState(state), onError(message). Returns { send(obj), close() }.
   */
  function connectRoom(code, role, helloExtra, onState, onError) {
    let ws = null;
    let closed = false;
    let retryMs = 1500;

    function open() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(code)}&role=${role}`);
      ws.onopen = () => {
        retryMs = 1500;
        ws.send(JSON.stringify({ t: 'hello', ...(helloExtra || {}) }));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'state') onState(msg.state);
        else if (msg.t === 'error' && onError) onError(msg.message);
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 1.6, 10000);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    }
    open();
    return {
      send(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      },
      close() { closed = true; try { ws && ws.close(); } catch { /* ignore */ } },
    };
  }

  /** Render a QR code into a <canvas>; falls back to plain text link. */
  function renderQR(canvas, text) {
    const fallback = () => {
      const box = canvas.parentElement;
      if (box) box.innerHTML = `<a class="join-link" href="${esc(text)}">${esc(text)}</a>`;
    };
    try {
      if (!window.CantinaQR || !canvas || !canvas.getContext) return fallback();
      window.CantinaQR.toCanvas(canvas, text, { width: 220, margin: 2, color: { dark: '#04140a', light: '#ffffff' } }, (err) => {
        if (err) fallback();
      });
    } catch { fallback(); }
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function copyText(text, doneMsg) {
    const done = () => toast(doneMsg || 'Copied to clipboard');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('Copy failed', true); }
    document.body.removeChild(ta);
  }

  window.Cantina = { esc, fmtMs, debounce, icons, api, guestId, roomCode, connectRoom, renderQR, toast, copyText };
})();
