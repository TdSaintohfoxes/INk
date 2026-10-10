/* INK — PDF engine (pdf.js).
 * Modes: continuous · single · two-page. Fit width / fit page, pinch + double-tap zoom, thumbnails,
 * outline, internal links, text selection, highlights (stored as page fractions), in-document search,
 * margin trim, themes, exact position resume, scanned-document detection (no OCR).
 */
import { h, icon, clamp, debounce, rafThrottle } from './ink-util.js';
import * as settings from './ink-settings.js';
import * as db from './ink-db.js';
import { loadPdfjs, openPdf, isPasswordError } from './ink-pdfjs.js';
import { segmented, slider, toggleRow, field, group, swatches, toast, closeAllSheets } from './ink-ui.js';
import { showSelBar } from './ink-selbar.js';
import { define, isWord } from './ink-dict.js';
import { hlColor } from './ink-reader.js';

const GAP = 10, MARGIN = 8, MAX_PIXELS = 9e6;

export async function open({ book, blob, host, api, saved, gotoQuery }) {
  const pdfjs = await loadPdfjs();
  let pdf = null, password;
  for (let tries = 0; ; tries++) {
    try { pdf = await openPdf(blob, { password }); break; }
    catch (e) {
      if (!isPasswordError(e)) throw e;
      const pw = await api.askPassword(tries > 0);
      if (!pw) throw Object.assign(new Error('cancelled'), { cancelled: true });
      password = pw;
    }
  }
  const N = pdf.numPages;
  const P = () => settings.get('pdf');

  /* ---------- sizes ---------- */
  const sizes = new Array(N).fill(null);
  const pageCache = new Map();
  const getPage = (i) => { let p = pageCache.get(i); if (!p) { p = pdf.getPage(i + 1); pageCache.set(i, p); if (pageCache.size > 12) { const k = pageCache.keys().next().value; pageCache.get(k).then((pg) => pg.cleanup?.()).catch(() => {}); pageCache.delete(k); } } return p; };
  async function ensureSize(i) {
    if (sizes[i]) return sizes[i];
    const pg = await getPage(i); const v = pg.getViewport({ scale: 1 });
    return (sizes[i] = { w: v.width, h: v.height });
  }
  const s0 = await ensureSize(0);
  const sz = (i) => sizes[i] || sizes[Math.max(0, i - 1)] || s0;

  /* ---------- DOM ---------- */
  const root = h('div', { class: 'pd' });
  const scroller = h('div', { class: 'pd-scroller' });
  const doc = h('div', { class: 'pd-doc' });
  scroller.append(doc); root.append(scroller);
  host.replaceChildren(root);

  let destroyed = false, zoom = 1, cw = 0, ch = 0;
  let cur = 0, curY = 0;                       // current page + fraction from its top
  let mode = P().mode;
  let crop = { l: 0, t: 0, r: 0, b: 0 };
  const st = new Array(N).fill(null);          // per page state
  let tops = [], heights = [], widths = [], lefts = [];
  let spread = [0];                            // paged modes
  let marks = [];                              // user highlights
  let tocP = null;

  function applyTheme() {
    const t = settings.readingTheme(), r = settings.get('reading.theme');
    const key = r === 'auto' ? settings.resolvedTheme() : r;
    root.classList.toggle('dark', key === 'dark' || key === 'oled');
    root.classList.toggle('sepia', key === 'sepia');
    const bg = key === 'oled' ? '#000' : key === 'dark' ? '#101012' : key === 'sepia' ? '#cfc2a2' : key === 'custom' ? t.bg : '#c9c6bf';
    root.style.setProperty('--pd-bg', bg); host.style.setProperty('--rd-bg', bg);
  }
  applyTheme();

  /* ---------- scale / geometry ---------- */
  const eff = (i) => { const s = sz(i); return { w: s.w * (1 - crop.l - crop.r), h: s.h * (1 - crop.t - crop.b) }; };
  function scaleFor(i) {
    const e = eff(i); const f = P().fit;
    const aw = cw - MARGIN * 2, ah = ch - MARGIN * 2;
    let base;
    if (mode === 'continuous') base = aw / e.w;
    else if (mode === 'double') { const w2 = (aw - 4) / 2; base = f === 'page' ? Math.min(w2 / e.w, ah / e.h) : w2 / e.w; }
    else base = f === 'page' ? Math.min(aw / e.w, ah / e.h) : aw / e.w;
    return Math.max(0.05, base * zoom);
  }
  function relayout(anchor) {
    cw = scroller.clientWidth; ch = scroller.clientHeight;
    if (!cw) return;
    if (mode === 'continuous') {
      tops = []; heights = []; widths = []; let y = MARGIN, maxW = 0;
      for (let i = 0; i < N; i++) { const e = eff(i), s = scaleFor(i); widths[i] = e.w * s; heights[i] = e.h * s; tops[i] = y; y += heights[i] + GAP; maxW = Math.max(maxW, widths[i]); }
      const dw = Math.max(cw, maxW + MARGIN * 2), dh = y - GAP + MARGIN;
      lefts = widths.map((w) => (dw - w) / 2);
      doc.style.width = dw + 'px'; doc.style.height = dh + 'px';
      for (const i of mounted) place(i);
    } else {
      tops = []; heights = []; widths = []; lefts = [];
      let totalW = 0, maxH = 0;
      spread.forEach((i) => { const e = eff(i), s = scaleFor(i); widths[i] = e.w * s; heights[i] = e.h * s; totalW += widths[i]; maxH = Math.max(maxH, heights[i]); });
      totalW += (spread.length - 1) * 4;
      const dw = Math.max(cw, totalW + MARGIN * 2), dh = Math.max(ch, maxH + MARGIN * 2);
      let x = (dw - totalW) / 2;
      spread.forEach((i) => { lefts[i] = x; tops[i] = (dh - heights[i]) / 2; x += widths[i] + 4; });
      doc.style.width = dw + 'px'; doc.style.height = dh + 'px';
      for (const i of mounted) place(i);
    }
    if (anchor) anchor();
  }
  const mounted = new Set();
  function place(i) {
    const s = st[i]; if (!s) return;
    const el = s.el;
    el.style.width = widths[i] + 'px'; el.style.height = heights[i] + 'px';
    el.style.left = lefts[i] + 'px'; el.style.top = tops[i] + 'px';
    const sc = scaleFor(i), z = sz(i);
    s.inner.style.width = z.w * sc + 'px'; s.inner.style.height = z.h * sc + 'px';
    s.inner.style.left = -crop.l * z.w * sc + 'px'; s.inner.style.top = -crop.t * z.h * sc + 'px';
  }
  function mount(i) {
    if (st[i]?.el) { mounted.add(i); return st[i]; }
    const inner = h('div', { class: 'pd-in', style: { position: 'absolute' } });
    const hl = h('div', { class: 'pd-hl' });
    const links = h('div', { class: 'pd-links' });
    const text = h('div', { class: 'pd-text textLayer' });
    inner.append(hl, text, links);
    const el = h('div', { class: 'pd-page', 'data-p': i, style: { position: 'absolute', margin: 0 }, role: 'img', 'aria-label': 'Page ' + (i + 1) }, h('div', { class: 'pd-ph' }, i + 1), inner);
    el.dataset.p = i;
    doc.append(el);
    const s = st[i] = { el, inner, hl, text, links, canvas: null, key: '', task: null, busy: false, textDone: false };
    mounted.add(i);
    place(i); drawHl(i);
    return s;
  }
  function unmount(i, keepEl) {
    const s = st[i]; if (!s) return;
    try { s.task?.cancel(); } catch { /* ignore */ }
    if (s.canvas) { s.canvas.width = s.canvas.height = 0; }
    s.el.remove(); st[i] = null; mounted.delete(i);
  }

  /* ---------- rendering ---------- */
  const queue = new Set(); let rendering = false;
  const want = new Set();
  function requestRender(i) { if (i < 0 || i >= N) return; want.add(i); if (!rendering) pump(); }
  async function pump() {
    rendering = true;
    while (want.size && !destroyed) {
      // closest to the current page first
      const i = [...want].sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur))[0];
      want.delete(i);
      if (!st[i]) continue;
      try { await renderPage(i); } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn('render', i, e); }
    }
    rendering = false;
  }
  async function renderPage(i) {
    const s = st[i]; if (!s) return;
    await ensureSize(i);
    if (!st[i]) return;
    relayoutIfSizeChanged(i);
    const scale = scaleFor(i), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const key = scale.toFixed(3) + '|' + dpr;
    if (s.key === key && s.canvas) return;
    const page = await getPage(i);
    if (!st[i] || destroyed) return;
    const z = sz(i);
    let q = scale * dpr;
    const px = z.w * q * z.h * q;
    if (px > MAX_PIXELS) q *= Math.sqrt(MAX_PIXELS / px);
    const vp = page.getViewport({ scale: q });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const c2 = canvas.getContext('2d', { alpha: false });
    c2.fillStyle = '#fff'; c2.fillRect(0, 0, canvas.width, canvas.height);
    s.busy = true;
    const task = page.render({ canvasContext: c2, canvas, viewport: vp });
    s.task = task;
    try { await task.promise; } catch (e) { s.busy = false; if (e?.name === 'RenderingCancelledException') return; throw e; }
    s.busy = false;
    if (!st[i]) return;
    const old = s.canvas;
    s.inner.insertBefore(canvas, s.inner.firstChild);
    s.canvas = canvas; s.key = key;
    s.el.querySelector('.pd-ph')?.remove();
    if (old) old.remove();
    if (!s.textDone || s.textScale !== scale) await buildText(i, page, scale);
    if (!s.linksDone) buildLinks(i, page, scale);
    if (pendingFind && pendingFind.page === i) applyFind(i);
  }
  function relayoutIfSizeChanged() { /* sizes are refined in the background; layout is refreshed there */ }
  async function buildText(i, page, scale) {
    const s = st[i]; if (!s) return;
    const vp = page.getViewport({ scale });
    s.text.replaceChildren();
    s.text.style.setProperty('--total-scale-factor', scale);
    s.text.style.setProperty('--scale-factor', scale);
    s.text.style.width = vp.width + 'px'; s.text.style.height = vp.height + 'px';
    try {
      const tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: s.text, viewport: vp });
      await tl.render();
      s.textDone = true; s.textScale = scale;
    } catch (e) { if (e?.name !== 'AbortException') console.warn('text layer', e); }
  }
  async function buildLinks(i, page, scale) {
    const s = st[i]; if (!s) return;
    s.linksDone = true;
    try {
      const anns = await page.getAnnotations({ intent: 'display' });
      const vp = page.getViewport({ scale: 1 });
      for (const a of anns) {
        if (a.subtype !== 'Link' || (!a.dest && !a.url && !a.unsafeUrl)) continue;
        const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
        const l = Math.min(x1, x2) / vp.width, t = Math.min(y1, y2) / vp.height, w = Math.abs(x2 - x1) / vp.width, hh = Math.abs(y2 - y1) / vp.height;
        const el = h('a', { class: 'pd-link', href: a.url || '#', style: { position: 'absolute', left: l * 100 + '%', top: t * 100 + '%', width: w * 100 + '%', height: hh * 100 + '%', zIndex: 3 } });
        if (a.url) { el.target = '_blank'; el.rel = 'noopener noreferrer'; }
        else el.addEventListener('click', async (ev) => { ev.preventDefault(); ev.stopPropagation(); const pi = await destToPage(a.dest); if (pi != null) goPage(pi, 0, true); });
        s.links.append(el);
      }
    } catch { /* annotations are optional */ }
  }
  async function destToPage(dest) {
    try {
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) return null;
      const r = dest[0];
      if (r && typeof r === 'object') return await pdf.getPageIndex(r);
      if (Number.isInteger(r)) return r;
    } catch { /* ignore */ }
    return null;
  }

  /* ---------- visibility / virtualization ---------- */
  const update = rafThrottle(() => {
    if (destroyed) return;
    if (mode === 'continuous') {
      const t = scroller.scrollTop, b = t + ch;
      let lo = indexAt(t - ch * 0.8), hi = indexAt(b + ch * 1.2);
      for (const i of [...mounted]) if (i < lo - 2 || i > hi + 2) unmount(i);
      for (let i = lo; i <= hi; i++) { mount(i); if (!st[i].canvas || st[i].key.split('|')[0] !== scaleFor(i).toFixed(3)) requestRender(i); }
      const ref = t + ch * 0.2, p = indexAt(ref);
      const y = clamp((ref - tops[p]) / Math.max(1, heights[p]), 0, 1);
      const moved = p !== cur;
      cur = p; curY = y;
      report(moved);
    }
  });
  function indexAt(y) {
    let lo = 0, hi = N - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tops[m] <= y) lo = m; else hi = m - 1; }
    return lo;
  }
  scroller.addEventListener('scroll', () => { if (mode === 'continuous') { api.interaction(); update(); if (api.chromeVisible() && scrolledBy()) api.hideChrome(); } }, { passive: true });
  let lastTop = 0;
  const scrolledBy = () => { const d = Math.abs(scroller.scrollTop - lastTop); lastTop = scroller.scrollTop; return d > 30; };

  function report(turned) {
    const lab = mode === 'double' && spread.length === 2 ? `Pages ${spread[0] + 1}–${spread[1] + 1} of ${N}` : `Page ${cur + 1} of ${N}`;
    const progress = N > 1 ? clamp((cur + (mode === 'continuous' ? curY : 0)) / (N - 1), 0, 1) : 1;
    api.relocate({ location: { page: cur, y: mode === 'continuous' ? +curY.toFixed(4) : 0 }, progress, label: lab, sub: zoom > 1.02 ? Math.round(zoom * 100) + '%' : '', turned });
  }

  /* ---------- navigation ---------- */
  function spreadFor(i) {
    if (mode !== 'double') return [i];
    if (i === 0 || i + 1 >= N) return [i];
    // keep pairs aligned: (1,2) (3,4) … with the cover alone
    const a = i % 2 === 1 ? i : i - 1;
    return [a, a + 1].filter((x) => x < N);
  }
  async function showSpread(i, { y = 0, turned = false } = {}) {
    spread = spreadFor(clamp(i, 0, N - 1));
    await Promise.all(spread.map(ensureSize));
    for (const k of [...mounted]) unmount(k);
    spread.forEach((k) => mount(k));
    cur = spread[0]; curY = 0;
    relayout();
    scroller.scrollLeft = (doc.offsetWidth - cw) / 2; scroller.scrollTop = y ? y * heights[cur] : 0;
    spread.forEach(requestRender);
    // warm neighbours
    [spread[spread.length - 1] + 1, cur - 1].forEach((k) => { if (k >= 0 && k < N) getPage(k); });
    report(turned);
  }
  async function goPage(i, y = 0, turned = false) {
    i = clamp(Math.round(i), 0, N - 1);
    if (mode === 'continuous') {
      await ensureSize(i);
      cur = i; curY = y;
      scroller.scrollTop = Math.max(0, tops[i] + y * heights[i] - ch * 0.2 + (y ? 0 : ch * 0.2 - MARGIN));
      update();
      cur = i; report(turned);
    } else await showSpread(i, { y, turned });
  }
  function step(dir) {
    if (mode === 'continuous') { scroller.scrollBy({ top: dir * ch * 0.88, behavior: document.documentElement.dataset.motion === 'reduce' ? 'auto' : 'smooth' }); return; }
    const to = dir > 0 ? spread[spread.length - 1] + 1 : mode === 'double' ? (cur <= 1 ? 0 : cur - 2) : cur - 1;
    if (to < 0 || to >= N) { if (dir > 0) toast('End of document'); return; }
    showSpread(to, { turned: true });
  }

  /* ---------- background size refinement ---------- */
  (async () => {
    const limit = Math.min(N, 800);
    for (let i = 1; i < limit && !destroyed; i++) {
      if (sizes[i]) continue;
      await ensureSize(i);
      if (i % 25 === 0) { await new Promise((r) => setTimeout(r, 0)); }
    }
    if (destroyed || mode !== 'continuous') return;
    // refresh geometry, keeping the reading position
    const keep = { page: cur, y: curY };
    relayout();
    scroller.scrollTop = Math.max(0, tops[keep.page] + keep.y * heights[keep.page] - ch * 0.2);
    update();
  })();

  /* ---------- trim ---------- */
  async function computeTrim() {
    if (!P().trim) { crop = { l: 0, t: 0, r: 0, b: 0 }; return; }
    const picks = [...new Set([...Array(6)].map((_, k) => clamp(Math.round((k + 0.5) * N / 6), 0, N - 1)))];
    const boxes = [];
    for (const i of picks) {
      try {
        const page = await getPage(i); const v0 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 220 / v0.width });
        const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        const x = c.getContext('2d', { willReadFrequently: true, alpha: false }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: x, canvas: c, viewport: vp }).promise;
        const d = x.getImageData(0, 0, c.width, c.height).data;
        let x0 = c.width, x1 = 0, y0 = c.height, y1 = 0;
        for (let j = 0; j < c.height; j++) for (let k = 0; k < c.width; k++) { const o = (j * c.width + k) * 4; if (d[o] < 225 || d[o + 1] < 225 || d[o + 2] < 225) { if (k < x0) x0 = k; if (k > x1) x1 = k; if (j < y0) y0 = j; if (j > y1) y1 = j; } }
        if (x1 > x0 && y1 > y0) boxes.push({ l: x0 / c.width, r: 1 - (x1 + 1) / c.width, t: y0 / c.height, b: 1 - (y1 + 1) / c.height });
      } catch { /* skip */ }
    }
    if (boxes.length < 2) { crop = { l: 0, t: 0, r: 0, b: 0 }; return; }
    const m = (k) => Math.min(...boxes.map((b) => b[k]));       // safest: smallest margin seen
    const pad = 0.012;
    crop = { l: Math.max(0, m('l') - pad), r: Math.max(0, m('r') - pad), t: Math.max(0, m('t') - pad), b: Math.max(0, m('b') - pad) };
  }

  /* ---------- re-layout driver ---------- */
  function rebuild(keepPos = true) {
    const p = cur, y = curY;
    for (const i of [...mounted]) unmount(i);
    queue.clear(); want.clear();
    if (mode === 'continuous') { relayout(); scroller.scrollTop = Math.max(0, tops[p] + y * heights[p] - ch * 0.2); update(); }
    else showSpread(p);
  }
  const onResize = debounce(() => { if (scroller.clientWidth !== cw || scroller.clientHeight !== ch) rebuild(); }, 150);
  const ro = new ResizeObserver(onResize); ro.observe(scroller);

  /* ---------- gestures ---------- */
  let touch = null, pinch = null, lastTapT = 0, lastTapX = 0, lastTapY = 0;
  const hasSelection = () => { const s = getSelection(); return s && !s.isCollapsed && scroller.contains(s.anchorNode); };
  scroller.addEventListener('touchstart', (e) => {
    api.interaction();
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z0: zoom, f: 1, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
      const r = scroller.getBoundingClientRect();
      pinch.ox = scroller.scrollLeft + pinch.cx - r.left; pinch.oy = scroller.scrollTop + pinch.cy - r.top;
      doc.style.transformOrigin = `${pinch.ox}px ${pinch.oy}px`;
      touch = null;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      touch = { x: t.clientX, y: t.clientY, t: performance.now(), sl: scroller.scrollLeft, moved: false };
    }
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const f = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d0;
      pinch.f = clamp(pinch.z0 * f, 0.5, 5) / pinch.z0;
      doc.style.transform = `scale(${pinch.f})`;
    } else if (touch) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 10) touch.moved = true;
    }
  }, { passive: false });
  scroller.addEventListener('touchend', (e) => {
    if (pinch && e.touches.length < 2) {
      const p = pinch; pinch = null;
      doc.style.transform = ''; doc.style.transformOrigin = '';
      if (Math.abs(p.f - 1) > 0.02) setZoom(p.z0 * p.f, { fx: p.cx, fy: p.cy });
      touch = null; return;
    }
    if (!touch || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y, dt = performance.now() - touch.t;
    const tt = touch; touch = null;
    if (!tt.moved && dt < 330) {
      if (hasSelection()) return;
      const now = performance.now();
      if (now - lastTapT < 300 && Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 40) { lastTapT = 0; doubleTap(t.clientX, t.clientY); return; }
      lastTapT = now; lastTapX = t.clientX; lastTapY = t.clientY;
      setTimeout(() => { if (lastTapT === now) { lastTapT = 0; singleTap(t.clientX); } }, 305);
      return;
    }
    // swipe to turn page (paged modes, when the page can't scroll further sideways)
    if (mode !== 'continuous' && Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * 0.6 && dt < 600) {
      const atEdge = dx < 0 ? scroller.scrollLeft + cw >= doc.offsetWidth - 2 : scroller.scrollLeft <= 2;
      if (atEdge || Math.abs(scroller.scrollLeft - tt.sl) < 2) step(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
  scroller.addEventListener('click', (e) => {
    if (e.pointerType === 'touch' || (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents)) return;
    if (hasSelection()) return;
    if (e.detail === 2) { doubleTap(e.clientX, e.clientY); return; }
    if (e.target.closest('a')) return;
    setTimeout(() => { singleTap(e.clientX); }, 0);
  });
  function singleTap(x) {
    if (!settings.get('reading.tapNav')) { api.toggleChrome(); return; }
    const f = x / cw;
    if (f < 0.25) step(-1); else if (f > 0.75) step(1); else api.toggleChrome();
  }
  function doubleTap(x, y) { setZoom(zoom > 1.2 ? 1 : 2.2, { fx: x, fy: y }); }
  function setZoom(z, focus) {
    z = clamp(z, 0.5, 5);
    const r = scroller.getBoundingClientRect();
    const fx = focus ? focus.fx - r.left : cw / 2, fy = focus ? focus.fy - r.top : ch / 2;
    const ox = scroller.scrollLeft + fx, oy = scroller.scrollTop + fy;
    const w0 = doc.offsetWidth, h0 = doc.offsetHeight;
    const old = zoom; zoom = Math.abs(z - 1) < 0.04 ? 1 : z;
    const p = cur, py = curY;
    for (const i of [...mounted]) { const s = st[i]; if (s) { s.key = ''; } }
    relayout();
    const k = zoom / old;
    scroller.scrollLeft = ox * (doc.offsetWidth / w0) - fx;
    if (mode === 'continuous') scroller.scrollTop = oy * (doc.offsetHeight / h0) - fy;
    else scroller.scrollTop = oy * (doc.offsetHeight / h0) - fy;
    update(); if (mode !== 'continuous') spread.forEach(requestRender);
    report(false);
  }
  scroller.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9), { fx: e.clientX, fy: e.clientY }); }
  }, { passive: false });

  const onKey = (e) => {
    if (e.target.closest?.('input,textarea')) return;
    const k = e.key;
    if (k === 'ArrowRight' || (k === 'ArrowDown' && mode !== 'continuous')) step(1);
    else if (k === 'ArrowLeft' || (k === 'ArrowUp' && mode !== 'continuous')) step(-1);
    else if (k === ' ' || k === 'PageDown') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (k === 'PageUp') step(-1);
    else if (k === 'Home') goPage(0); else if (k === 'End') goPage(N - 1);
    else if (k === '+' || k === '=') setZoom(zoom * 1.25); else if (k === '-') setZoom(zoom / 1.25);
    else if (k === '0') setZoom(1);
  };
  addEventListener('keydown', onKey);

  /* ---------- highlights ---------- */
  async function loadMarks() { marks = await db.listHighlights(book.id); for (const i of mounted) drawHl(i); }
  function drawHl(i) {
    const s = st[i]; if (!s) return;
    s.hl.replaceChildren();
    for (const m of marks) {
      if (m.location?.page !== i) continue;
      for (const r of m.rects || []) s.hl.append(h('i', { style: { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%', '--hl': hlColor(m.color) } }));
    }
  }
  let closeBar = null;
  const onSel = debounce(() => {
    closeBar?.(); closeBar = null;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !scroller.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest('.pd-page');
    if (!startEl) return;
    const pi = +startEl.dataset.p, s = st[pi]; if (!s) return;
    const box = s.inner.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1 && r.top >= box.top - 2 && r.bottom <= box.bottom + 2)
      .map((r) => ({ x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height }));
    if (!rects.length) return;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    const rr = range.getBoundingClientRect();
    closeBar = showSelBar({
      host: root, rect: rr,
      onDefine: isWord(text) ? () => { sel.removeAllRanges(); closeBar?.(); closeBar = null; define(text); } : null,
      onColor: async (color) => {
        const hh = await db.saveHighlight({ bookId: book.id, location: { page: pi }, rects: merge(rects), text: text.slice(0, 600), color, label: 'Page ' + (pi + 1) });
        marks.push(hh); drawHl(pi); sel.removeAllRanges(); closeBar?.(); closeBar = null; api.interaction();
      },
      onCopy: () => { navigator.clipboard?.writeText(text).then(() => toast('Copied')).catch(() => toast('Couldn’t copy')); sel.removeAllRanges(); closeBar?.(); },
    });
  }, 220);
  document.addEventListener('selectionchange', onSel);
  function merge(rects) {   // join rectangles that sit on one text line
    const out = [];
    for (const r of rects.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const l = out[out.length - 1];
      if (l && Math.abs(l.y - r.y) < 0.004 && r.x - (l.x + l.w) < 0.012) { const right = Math.max(l.x + l.w, r.x + r.w); l.w = right - l.x; l.h = Math.max(l.h, r.h); }
      else out.push({ ...r });
    }
    return out;
  }

  /* ---------- search ---------- */
  let pendingFind = null;
  function applyFind(i) {
    const s = st[i]; if (!s || !pendingFind) return;
    const q = pendingFind.q.toLowerCase();
    s.text.querySelectorAll('span').forEach((sp) => {
      if (sp.textContent.toLowerCase().includes(q)) { sp.style.background = 'color-mix(in srgb, var(--accent) 45%, transparent)'; sp.style.borderRadius = '2px'; }
    });
    pendingFind = null;
  }
  async function search(q, { signal, onHit }) {
    const needle = q.toLowerCase();
    for (let i = 0; i < N; i++) {
      if (signal?.aborted) return;
      let text = '';
      try {
        const tc = await (await getPage(i)).getTextContent();
        text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? ' ' : '')).join('');
      } catch { continue; }
      const low = text.toLowerCase();
      let from = 0, count = 0;
      while (count < 4) {
        const k = low.indexOf(needle, from); if (k < 0) break;
        from = k + needle.length; count++;
        const a = Math.max(0, k - 45), b = Math.min(text.length, k + needle.length + 70);
        const cont = onHit({ label: 'Page ' + (i + 1), snippet: (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : ''), location: { page: i, q } });
        if (cont === false) return;
      }
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }

  /* ---------- outline ---------- */
  async function buildToc() {
    try {
      const out = await pdf.getOutline();
      if (!out) return [];
      const flat = [];
      const walk = async (items, depth) => {
        for (const it of items) {
          const p = await destToPage(it.dest);
          if (p != null) flat.push({ label: (it.title || '').trim() || 'Untitled', location: { page: p }, depth });
          if (it.items?.length) await walk(it.items, depth + 1);
        }
      };
      await walk(out, 0);
      return flat;
    } catch { return []; }
  }
  tocP = buildToc();

  /* ---------- scanned detection ---------- */
  (async () => {
    if (book.meta?.scanned !== undefined) { if (book.meta.scanned) toast('This looks like a scanned PDF — text search and selection aren’t available.', { ms: 5000 }); return; }
    let chars = 0;
    const probe = [0, 1, 2, Math.floor(N / 2), N - 1].filter((v, i, a) => v >= 0 && v < N && a.indexOf(v) === i);
    for (const i of probe) { try { chars += (await (await getPage(i)).getTextContent()).items.reduce((n, it) => n + (it.str || '').length, 0); } catch { /* ignore */ } }
    const scanned = N > 0 && chars < 20;
    db.patchBook(book.id, { meta: { ...book.meta, scanned } }, { silent: true }).catch(() => {});
    book.meta = { ...book.meta, scanned };
    if (scanned && !destroyed) toast('This looks like a scanned PDF — text search and selection aren’t available.', { ms: 5500 });
  })();

  /* ---------- start ---------- */
  await computeTrim();
  await loadMarks();
  cw = scroller.clientWidth || host.clientWidth || innerWidth; ch = scroller.clientHeight || host.clientHeight || innerHeight;
  const start = typeof saved === 'object' && saved ? saved : { page: 0, y: 0 };
  if (mode === 'continuous') { relayout(); await goPage(start.page || 0, start.y || 0); }
  else await showSpread(start.page || 0);
  if (gotoQuery && start.page != null) pendingFind = { page: start.page, q: gotoQuery };

  /* ---------- page adjustments & auto-scroll ---------- */
  const applyAdj = () => root.style.setProperty('--pd-adj', `brightness(${P().brightness ?? 1}) contrast(${P().contrast ?? 1})`);
  applyAdj();
  let auto = false, autoRaf = 0, autoLast = 0, autoAcc = 0;
  const autoStop = () => { auto = false; cancelAnimationFrame(autoRaf); autoRaf = 0; autoSync?.(false); };
  let autoSync = null;
  function autoTick(t) {
    if (!auto || destroyed) return;
    const dt = autoLast ? Math.min(64, t - autoLast) : 16; autoLast = t;
    autoAcc += ((P().autoSpeed || 4) * 9) * dt / 1000;          // px per second, fractional kept
    const whole = Math.floor(autoAcc);
    if (whole >= 1) {
      const before = scroller.scrollTop; scroller.scrollTop = before + whole; autoAcc -= whole;
      if (scroller.scrollTop === before) { autoStop(); toast('End of document'); return; }
    }
    autoRaf = requestAnimationFrame(autoTick);
  }
  function autoStart() {
    if (mode !== 'continuous') { toast('Auto-scroll works in Scroll layout'); return false; }
    auto = true; autoLast = 0; autoAcc = 0; api.hideChrome?.(); autoRaf = requestAnimationFrame(autoTick); return true;
  }
  for (const ev of ['touchstart', 'wheel', 'pointerdown']) scroller.addEventListener(ev, () => { if (auto) autoStop(); }, { passive: true });

  /* ---------- controller ---------- */
  const unsubTheme = settings.on((k) => { if (k === 'reading.theme' || k === 'app.theme' || k === 'app.system' || k === 'reading.customBg') applyTheme(); });

  return {
    kind: 'pdf',
    toc: tocP,
    tocIndex: async () => null,
    highlights: true,
    highlightsChanged: () => loadMarks(),
    goTo: (loc, opts) => {
      if (opts?.query && loc?.page != null) pendingFind = { page: loc.page, q: opts.query };
      if (typeof loc === 'number') return goPage(loc);
      return goPage(loc?.page ?? 0, loc?.y || 0, true);
    },
    next: () => step(1), prev: () => step(-1),
    nextChapter: async () => { const t = await tocP; const n = t.find((x) => x.location.page > cur); if (n) goPage(n.location.page); },
    prevChapter: async () => { const t = await tocP; const p = [...t].reverse().find((x) => x.location.page < cur); if (p) goPage(p.location.page); else goPage(0); },
    seek: (f) => goPage(f * (N - 1)),
    seekLabel: (f) => `Page ${Math.round(f * (N - 1)) + 1} of ${N}`,
    here: () => ({ location: { page: cur, y: curY }, progress: N > 1 ? cur / (N - 1) : 1 }),
    isVisible: (loc) => (mode === 'double' ? spread.includes(loc?.page) : loc?.page === cur),
    bookmarkTitle: () => `Page ${cur + 1}`,
    search,
    thumbs: {
      count: N, current: () => cur, aspect: `${s0.w} / ${s0.h}`, location: (i) => ({ page: i }),
      render: async (i) => {
        const page = await getPage(i); const v0 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 180 / v0.width });
        const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        const x = c.getContext('2d', { alpha: false }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: x, canvas: c, viewport: vp }).promise;
        return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.7));
      },
    },
    settingsPanel() {
      const wrap = h('div');
      const modeSeg = segmented([{ value: 'continuous', label: 'Scroll', icon: 'scroll' }, { value: 'single', label: 'Single', icon: 'single' }, { value: 'double', label: 'Two pages' }], mode, (v) => { settings.set('pdf.mode', v); const p = cur, y = curY; mode = v; zoom = 1; for (const i of [...mounted]) unmount(i); if (v === 'continuous') { relayout(); goPage(p, y); } else showSpread(p); }, { wrap: true });
      const fitSeg = segmented([{ value: 'width', label: 'Fit width' }, { value: 'page', label: 'Fit page' }], P().fit, (v) => { settings.set('pdf.fit', v); zoom = 1; rebuild(); });
      const zoomCtl = slider({ label: 'Zoom', min: 50, max: 400, step: 10, value: Math.round(zoom * 100), format: (v) => v + '%', onInput: debounce((v) => setZoom(v / 100), 120) });
      const items = [{ value: 'auto', label: 'Auto', bg: 'linear-gradient(135deg,#f8f6f0 50%,#1e1e21 50%)', fg: '#888' }].concat(Object.entries(settings.READING_THEMES).map(([value, t]) => ({ value, label: t.name, bg: t.bg, fg: t.fg })));
      const goIn = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: 1, max: N, placeholder: `1–${N}`, 'aria-label': 'Go to page', style: { maxWidth: '110px' } });
      const go = () => { const n = Math.round(+goIn.value); if (n >= 1 && n <= N) { goPage(n - 1); closeAllSheets(); } else toast(`Enter a page from 1 to ${N}`); };
      goIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      const autoRow = toggleRow({ label: 'Auto-scroll', hint: 'Hands-free reading in Scroll layout. Touch the page to pause.', value: auto, onChange: (v) => { if (v) { if (!autoStart()) autoSync?.(false); } else autoStop(); } });
      autoSync = (v) => autoRow.set(v);
      wrap.append(
        group('Go to', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, goIn, h('button', { class: 'btn ghost', onclick: go }, 'Go'), h('span', { class: 'row-hint' }, `Page ${cur + 1} of ${N}`))),
        group('Layout', field('Page layout', modeSeg), field('Fit', fitSeg), zoomCtl,
          toggleRow({ label: 'Trim margins', hint: 'Crops the white borders around text', value: P().trim, onChange: async (v) => { settings.set('pdf.trim', v); await computeTrim(); rebuild(); } })),
        group('Reading', autoRow, slider({ label: 'Auto-scroll speed', min: 1, max: 10, step: 1, value: P().autoSpeed || 4, format: (v) => v + '×', onInput: (v) => settings.set('pdf.autoSpeed', v) })),
        group('Appearance', slider({ label: 'Brightness', min: 0.6, max: 1.4, step: 0.05, value: P().brightness ?? 1, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { settings.set('pdf.brightness', v); applyAdj(); } }),
          slider({ label: 'Contrast', min: 0.7, max: 1.8, step: 0.05, value: P().contrast ?? 1, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { settings.set('pdf.contrast', v); applyAdj(); } }),
          field('Page colour', swatches(items, settings.get('reading.theme') === 'custom' ? 'auto' : settings.get('reading.theme'), (v) => settings.set('reading.theme', v)), 'Dark and sepia recolour the pages for comfortable night reading.')));
      return wrap;
    },
    destroy() {
      destroyed = true; autoStop();
      removeEventListener('keydown', onKey);
      document.removeEventListener('selectionchange', onSel);
      unsubTheme?.(); ro.disconnect(); closeBar?.();
      for (const i of [...mounted]) unmount(i);
      try { pdf.destroy(); } catch { /* ignore */ }
      host.replaceChildren();
    },
  };
}

export async function searchBlob(blob, query, { signal, onHit }) {
  let pdf;
  try { pdf = await openPdf(blob); } catch { return; }
  try {
    const needle = query.toLowerCase();
    for (let i = 1; i <= pdf.numPages; i++) {
      if (signal?.aborted) return;
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? ' ' : '')).join('');
      const k = text.toLowerCase().indexOf(needle);
      page.cleanup?.();
      if (k < 0) continue;
      const a = Math.max(0, k - 45), b = Math.min(text.length, k + needle.length + 70);
      if (onHit({ label: 'Page ' + i, snippet: (a ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + '…', location: { page: i - 1, q: query } }) === false) return;
    }
  } finally { try { await pdf.destroy(); } catch { /* ignore */ } }
}
