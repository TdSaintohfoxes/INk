/* INK — comic engine (CBZ / CBR).
 * Modes: single · double · continuous scroll · manga (right-to-left, combines with single/double).
 * Zoom + pan, double-tap zoom, pinch, brightness / contrast / sharpen / rotate / trim margins.
 * Panel-ready: pageInfo(i) exposes {w,h,url} so a panel detector can be added without touching navigation.
 */
import { h, icon, clamp, debounce } from './ink-util.js';
import * as settings from './ink-settings.js';
import * as db from './ink-db.js';
import { openComicSource } from './ink-comic-src.js';
import { thumbFromBlob } from './ink-covers.js';
import { segmented, slider, toggleRow, field, group, toast } from './ink-ui.js';

const MAX_ZOOM = 5;

export async function open({ book, blob, host, api, saved }) {
  const src = await openComicSource(blob);
  const N = src.names.length;
  if (!N) { src.close(); throw Object.assign(new Error('This comic has no pages.'), { code: 'empty' }); }

  const S = () => settings.get('comic');
  let prefs = { ...(book.prefs || {}) };
  const savePrefs = debounce(() => db.patchBook(book.id, { prefs }, { silent: true }), 400);
  const rtl = () => prefs.rtl ?? (book.meta?.rtl ? true : settings.get('reading.direction') === 'rtl');
  const modeSetting = () => prefs.mode || S().mode;           // auto | single | double | scroll
  let rot = 0;

  /* ---------- page cache ---------- */
  const pages = new Array(N).fill(null);             // {url, w, h, crop, p: Promise}
  const wantUrl = new Map();
  function load(i) {
    if (i < 0 || i >= N) return null;
    let p = pages[i];
    if (p) return p.p;
    p = pages[i] = { url: null, w: 0, h: 0, crop: null };
    p.p = (async () => {
      const b = await src.getBlob(i);
      p.url = URL.createObjectURL(b);
      const img = new Image(); img.src = p.url;
      try { await img.decode(); } catch { await new Promise((r) => { img.onload = img.onerror = r; }); }
      p.w = img.naturalWidth || 1000; p.h = img.naturalHeight || 1500;
      if (S().trim) p.crop = detectCrop(img);
      return p;
    })().catch((e) => { p.err = e; p.w = 1000; p.h = 1500; return p; });
    return p.p;
  }
  function drop(i) {
    const p = pages[i];
    if (p?.url) URL.revokeObjectURL(p.url);
    pages[i] = null;
  }
  function keepOnly(lo, hi) { for (let i = 0; i < N; i++) if ((i < lo || i > hi) && pages[i]) drop(i); }
  const wide = (i) => { const p = pages[i]; return !!p && p.w > p.h * 1.08; };
  const pageInfo = (i) => pages[i] && { w: pages[i].w, h: pages[i].h, url: pages[i].url };

  function detectCrop(img) {
    try {
      const W = 96, H = Math.max(8, Math.round(96 * img.naturalHeight / img.naturalWidth));
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, W, H);
      const d = x.getImageData(0, 0, W, H).data;
      const px = (i, j) => { const k = (j * W + i) * 4; return (d[k] + d[k + 1] + d[k + 2]) / 3; };
      const bg = (px(1, 1) + px(W - 2, 1) + px(1, H - 2) + px(W - 2, H - 2)) / 4;
      const diff = (i, j) => Math.abs(px(i, j) - bg) > 22;
      let x0 = W, x1 = 0, y0 = H, y1 = 0;
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (diff(i, j)) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
      if (x1 <= x0 || y1 <= y0) return null;
      const pad = 1.5;
      const cx = clamp((x0 - pad) / W, 0, 1), cy = clamp((y0 - pad) / H, 0, 1);
      const cw = clamp((x1 + pad + 1) / W, 0, 1) - cx, ch = clamp((y1 + pad + 1) / H, 0, 1) - cy;
      if (cw > 0.97 && ch > 0.97) return null;
      if (cw < 0.4 || ch < 0.4) return null;
      return { x: cx, y: cy, w: cw, h: ch };
    } catch { return null; }
  }

  /* ---------- DOM ---------- */
  const root = h('div', { class: 'cm' });
  const stage = h('div', { class: 'cm-stage' });
  const pageNo = h('div', { class: 'cm-pageno' });
  const filterSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  filterSvg.setAttribute('width', '0'); filterSvg.setAttribute('height', '0'); filterSvg.style.position = 'absolute';
  filterSvg.innerHTML = '<filter id="cm-sharp"><feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -0.6 0 -0.6 3.4 -0.6 0 -0.6 0"/></filter>';
  root.append(stage, pageNo, filterSvg);
  host.replaceChildren(root);
  host.style.setProperty('--rd-bg', '#0a0a0b');

  function applyFilters() {
    const s = S();
    const f = [];
    if (s.brightness !== 1) f.push(`brightness(${s.brightness})`);
    if (s.contrast !== 1) f.push(`contrast(${s.contrast})`);
    if (s.sharpen) f.push('url(#cm-sharp)');
    root.style.setProperty('--cm-filter', f.length ? f.join(' ') : 'none');
  }

  /* ---------- state ---------- */
  let cur = clamp(Number.isFinite(saved?.page) ? saved.page : (typeof saved === 'number' ? saved : 0), 0, N - 1);
  let mode = 'single';       // resolved: single | double | scroll
  let zoom = 1, tx = 0, ty = 0;
  let spreadEl = null, scrollEl = null;
  let vw = 0, vh = 0;
  let destroyed = false;
  let spreadPages = [cur];

  function resolveMode() {
    const m = modeSetting();
    if (m === 'scroll') return 'scroll';
    if (m === 'single') return 'single';
    if (m === 'double') return 'double';
    return vw > vh * 1.15 && vw >= 700 ? 'double' : 'single';        // auto
  }

  /* ---------- paged layout ---------- */
  function spreadFor(i) {
    if (mode !== 'double') return [i];
    if (S().firstPageAlone && i === 0) return [0];
    if (wide(i) || i + 1 >= N || wide(i + 1)) return [i];
    return [i, i + 1];
  }
  function fitSize(w, h2, boxW, boxH) {
    const r = Math.min(boxW / w, boxH / h2);
    return { w: w * r, h: h2 * r, r };
  }

  async function showPaged(i, { dir = 0, instant = true } = {}) {
    await Promise.all([load(i), load(i + 1), load(i - 1), load(i + 2)].filter(Boolean));
    if (destroyed) return;
    cur = i;
    spreadPages = spreadFor(i);
    if (spreadPages.length === 1 && mode === 'double' && i + 1 < N && !wide(i) && !(S().firstPageAlone && i === 0) && !wide(i + 1)) spreadPages = [i, i + 1];
    const list = rtl() && spreadPages.length === 2 ? [...spreadPages].reverse() : spreadPages;
    // layout
    const rotated = rot % 180 !== 0;
    const boxW = rotated ? vh : vw, boxH = rotated ? vw : vh;
    const dims = list.map((p) => { const pg = pages[p]; const c = S().trim && pg.crop; return c ? { w: pg.w * c.w, h: pg.h * c.h } : { w: pg.w, h: pg.h }; });
    const totalW = dims.reduce((a, d) => a + d.w * (1), 0);
    const maxH = Math.max(...dims.map((d) => d.h));
    const scale = Math.min(boxW / totalW, boxH / maxH);
    const el = h('div', { class: 'cm-spread' });
    list.forEach((p, k) => {
      const pg = pages[p];
      const c = S().trim && pg.crop;
      const d = dims[k];
      const box = h('div', { class: 'cm-pg' + (c ? ' trim' : ''), style: { width: d.w * scale + 'px', height: d.h * scale + 'px' } });
      const img = new Image(); img.alt = 'Page ' + (p + 1); img.decoding = 'async'; img.draggable = false;
      if (pg.url) img.src = pg.url;
      if (c) { img.style.width = 100 / c.w + '%'; img.style.height = 100 / c.h + '%'; img.style.left = -(c.x / c.w) * 100 + '%'; img.style.top = -(c.y / c.h) * 100 + '%'; }
      box.append(img); el.append(box);
    });
    const W = totalW * scale, H = maxH * scale;
    el.style.width = W + 'px'; el.style.height = H + 'px';
    el._W = W; el._H = H; el._rot = rot;
    const old = spreadEl;
    spreadEl = el;
    stage.append(el);
    zoom = 1; tx = 0; ty = 0;
    place(true);
    if (old) {
      if (dir && motion()) {
        old.style.transition = 'transform .2s var(--ease), opacity .2s'; old.style.opacity = '0';
        old.style.transform = `translate3d(${(parseFloat(old.dataset.x || 0)) + -dir * vw * 0.25}px, ${old.dataset.y || 0}px, 0) rotate(${old._rot}deg)`;
        el.animate([{ opacity: 0, transform: el.style.transform.replace(/translate3d\(([^,]+),/, (m, x) => `translate3d(${parseFloat(x) + dir * vw * 0.25}px,`) }, { opacity: 1, transform: el.style.transform }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
        setTimeout(() => old.remove(), 210);
      } else old.remove();
    }
    report(dir !== 0);
    // neighbours & memory
    const lo = Math.max(0, i - 3), hi = Math.min(N - 1, i + 4);
    keepOnly(lo, hi);
    for (let k = i + 1; k <= Math.min(N - 1, i + 3); k++) load(k);
  }
  const motion = () => document.documentElement.dataset.motion !== 'reduce';

  function bounds() {
    const el = spreadEl; if (!el) return { mx: 0, my: 0 };
    const rotated = el._rot % 180 !== 0;
    const w = (rotated ? el._H : el._W) * zoom, hh = (rotated ? el._W : el._H) * zoom;
    return { mx: Math.max(0, (w - vw) / 2), my: Math.max(0, (hh - vh) / 2) };
  }
  function place(initial) {
    const el = spreadEl; if (!el) return;
    const { mx, my } = bounds();
    tx = clamp(tx, -mx, mx); ty = clamp(ty, -my, my);
    const x = vw / 2 - el._W / 2 + tx, y = vh / 2 - el._H / 2 + ty;
    el.dataset.x = x; el.dataset.y = y;
    el.style.transformOrigin = '50% 50%';
    el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${el._rot}deg) scale(${zoom})`;
  }

  function report(turned) {
    const first = spreadPages[0], last = spreadPages[spreadPages.length - 1];
    const label = spreadPages.length > 1 ? `Pages ${first + 1}–${last + 1} of ${N}` : `Page ${first + 1} of ${N}`;
    pageNo.textContent = `${first + 1}${spreadPages.length > 1 ? '–' + (last + 1) : ''} / ${N}`;
    api.relocate({ location: { page: first }, progress: N > 1 ? (first) / (N - 1) : 1, label, sub: rtl() ? 'Right to left' : '', turned });
  }

  /* ---------- scroll mode ---------- */
  let io = null, items = [];
  function buildScroll(startAt) {
    teardownPaged();
    scrollEl = h('div', { class: 'cm-scroll' });
    const col = h('div', { class: 'cm-col' });
    scrollEl.append(col); stage.append(scrollEl);
    const zw = (prefs.scrollWidth || 100) / 100;
    col.style.width = Math.min(vw * zw, 1000 * zw) + 'px';
    items = [];
    for (let i = 0; i < N; i++) {
      const it = h('div', { class: 'cm-item', 'data-i': i }, h('div', { class: 'cm-n' }, i + 1));
      const known = pages[i];
      it.style.aspectRatio = known && known.w ? `${known.w} / ${known.h}` : '2 / 3';
      items.push(it); col.append(it);
    }
    io = new IntersectionObserver((es) => {
      for (const e of es) {
        const i = +e.target.dataset.i;
        if (e.isIntersecting) fillItem(i); else emptyItem(i);
      }
    }, { root: scrollEl, rootMargin: '120% 0px' });
    items.forEach((it) => io.observe(it));
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(() => { const t = items[startAt]; if (t) scrollEl.scrollTop = t.offsetTop; });
  }
  async function fillItem(i) {
    const it = items[i]; if (!it || it.dataset.on) return;
    it.dataset.on = '1';
    const pg = await load(i);
    if (destroyed || !it.dataset.on) return;
    it.style.aspectRatio = `${pg.w} / ${pg.h}`;
    const img = new Image(); img.decoding = 'async'; img.alt = 'Page ' + (i + 1); img.src = pg.url;
    it.querySelector('img')?.remove(); it.append(img);
    it.querySelector('.cm-n')?.remove();
  }
  function emptyItem(i) {
    const it = items[i]; if (!it || !it.dataset.on) return;
    delete it.dataset.on;
    it.querySelector('img')?.remove();
    drop(i);
  }
  let scrollRAF = 0;
  function onScroll() {
    api.interaction();
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
      scrollRAF = 0;
      const y = scrollEl.scrollTop + vh * 0.35;
      let lo = 0, hi = items.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (items[m].offsetTop <= y) lo = m; else hi = m - 1; }
      if (lo !== cur) { cur = lo; spreadPages = [cur]; report(true); }
      if (api.chromeVisible()) api.hideChrome();
    });
  }
  function teardownScroll() {
    io?.disconnect(); io = null;
    scrollEl?.remove(); scrollEl = null; items = [];
    for (let i = 0; i < N; i++) if (pages[i]) drop(i);
  }
  function teardownPaged() { spreadEl?.remove(); spreadEl = null; }

  /* ---------- (re)layout ---------- */
  async function layout(at = cur) {
    vw = stage.clientWidth || host.clientWidth || innerWidth;
    vh = stage.clientHeight || host.clientHeight || innerHeight;
    const next = resolveMode();
    applyFilters();
    if (next === 'scroll') {
      if (mode !== 'scroll' || !scrollEl) { teardownPaged(); mode = 'scroll'; cur = at; buildScroll(at); report(false); }
      else { const keep = cur; teardownScroll(); buildScroll(keep); }
      pageNo.hidden = true;
    } else {
      if (mode === 'scroll') teardownScroll();
      mode = next; pageNo.hidden = false;
      spreadEl?.remove(); spreadEl = null;
      await showPaged(clamp(at, 0, N - 1));
    }
  }
  const relayout = debounce(() => layout(), 120);
  const ro = new ResizeObserver(() => { if (stage.clientWidth !== vw || stage.clientHeight !== vh) relayout(); });
  ro.observe(stage);

  /* ---------- navigation ---------- */
  let busy = false;
  async function step(dirSign) {   // +1 forward in reading order
    if (mode === 'scroll') { scrollEl.scrollBy({ top: dirSign * vh * 0.85, behavior: motion() ? 'smooth' : 'auto' }); return; }
    if (busy) return;
    let to;
    if (dirSign > 0) { to = cur + spreadPages.length; if (to >= N) { toast('End of this comic'); return; } }
    else {
      if (cur <= 0) return;
      const a = cur - 2;
      await Promise.all([load(a), load(a + 1)]);
      to = (mode === 'double' && a >= 0 && !(S().firstPageAlone && a === 0 && false) && !wide(a) && !wide(a + 1) && !(S().firstPageAlone && a === 0)) ? a : cur - 1;
      if (mode === 'double' && cur === 1 && S().firstPageAlone) to = 0;
    }
    busy = true;
    try { await showPaged(to, { dir: dirSign }); } finally { busy = false; }
  }
  // visual left/right to reading direction
  const turn = (visual) => step(rtl() ? -visual : visual);
  const goPage = async (i) => { i = clamp(Math.round(i), 0, N - 1); if (mode === 'scroll') { cur = i; const t = items[i]; if (t) scrollEl.scrollTop = t.offsetTop; report(false); } else await showPaged(i); };

  /* ---------- gestures (paged) ---------- */
  const pts = new Map();
  let g = null;     // gesture state
  let lastTap = 0, lastTapX = 0, lastTapY = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (mode === 'scroll') return;
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    api.interaction();
    if (pts.size === 1) g = { sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false, tx0: tx, ty0: ty, mode: null, id: e.pointerId };
    else if (pts.size === 2) { const [a, b] = [...pts.values()]; g = { pinch: true, d0: Math.hypot(a.x - b.x, a.y - b.y), z0: zoom, cx0: (a.x + b.x) / 2, cy0: (a.y + b.y) / 2, tx0: tx, ty0: ty }; }
  });
  stage.addEventListener('pointermove', (e) => {
    if (mode === 'scroll' || !pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoom = clamp(g.z0 * d / g.d0, 1, MAX_ZOOM);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      tx = g.tx0 + (cx - g.cx0); ty = g.ty0 + (cy - g.cy0);
      place(); return;
    }
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) > 8) { g.moved = true; g.mode = zoom > 1.02 ? 'pan' : (Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'none'); }
    if (!g.moved) return;
    if (g.mode === 'pan') {
      const { mx } = bounds();
      const nx = g.tx0 + dx;
      // at the edge of a zoomed page, a further swipe turns the page
      if (Math.abs(nx) > mx + 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { g.mode = 'swipe-edge'; g.edge = dx; }
      else { tx = nx; ty = g.ty0 + dy; place(); }
    } else if (g.mode === 'swipe' && spreadEl) {
      spreadEl.style.transition = 'none';
      const r = spreadEl._rot;
      spreadEl.style.transform = `translate3d(${parseFloat(spreadEl.dataset.x) + dx * 0.9}px, ${spreadEl.dataset.y}px, 0) rotate(${r}deg) scale(${zoom})`;
    }
  });
  const end = (e) => {
    if (mode === 'scroll' || !pts.has(e.pointerId)) return;
    const was = g;
    pts.delete(e.pointerId);
    if (pts.size > 0) { if (pts.size === 1 && g?.pinch) { const [p] = [...pts.values()]; g = { sx: p.x, sy: p.y, t: performance.now(), moved: true, tx0: tx, ty0: ty, mode: 'pan' }; } return; }
    g = null;
    if (!was || was.pinch) { if (zoom < 1.05) { zoom = 1; tx = ty = 0; place(); } return; }
    const dx = e.clientX - was.sx, dy = e.clientY - was.sy, dt = performance.now() - was.t;
    if (!was.moved) {
      // tap
      const now = performance.now();
      if (now - lastTap < 280 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) { lastTap = 0; doubleTap(e.clientX, e.clientY); return; }
      lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY;
      setTimeout(() => { if (lastTap === now) { lastTap = 0; singleTap(e.clientX); } }, 285);
      return;
    }
    if (was.mode === 'swipe' || was.mode === 'swipe-edge') {
      const d = was.mode === 'swipe-edge' ? was.edge : dx;
      const fast = Math.abs(d) > 40 && dt < 260;
      if (Math.abs(d) > vw * 0.22 || fast) {
        if (zoom > 1.02) { zoom = 1; tx = ty = 0; }
        turn(d < 0 ? 1 : -1);
        return;
      }
      if (spreadEl) { spreadEl.style.transition = 'transform .22s var(--ease)'; place(); setTimeout(() => spreadEl && (spreadEl.style.transition = ''), 240); }
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  function singleTap(x) {
    if (!settings.get('reading.tapNav')) { api.toggleChrome(); return; }
    const f = x / vw;
    if (f < 0.28) turn(-1); else if (f > 0.72) turn(1); else api.toggleChrome();
  }
  function doubleTap(x, y) {
    if (zoom > 1.1) { zoom = 1; tx = ty = 0; }
    else {
      zoom = 2.6;
      tx = -(x - vw / 2) * (zoom - 1); ty = -(y - vh / 2) * (zoom - 1);
    }
    if (spreadEl) { spreadEl.style.transition = 'transform .24s var(--ease)'; place(); setTimeout(() => spreadEl && (spreadEl.style.transition = ''), 260); }
  }
  // scroll mode taps
  let sTap = null;
  stage.addEventListener('click', (e) => {
    if (mode !== 'scroll') return;
    api.interaction();
    const f = e.clientX / vw, y = e.clientY / vh;
    if (!settings.get('reading.tapNav') || (f > 0.28 && f < 0.72)) api.toggleChrome();
    else step(f < 0.5 ? -1 : 1);
  });
  stage.addEventListener('wheel', (e) => {
    if (mode === 'scroll') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { zoom = clamp(zoom * (e.deltaY < 0 ? 1.12 : 0.89), 1, MAX_ZOOM); if (zoom === 1) tx = ty = 0; place(); }
    else if (zoom > 1.02) { tx -= e.deltaX; ty -= e.deltaY; place(); }
    else if (Math.abs(e.deltaY) > 18 || Math.abs(e.deltaX) > 18) { if (!wheelBusy) { wheelBusy = true; turn(e.deltaY + e.deltaX > 0 ? 1 : -1); setTimeout(() => (wheelBusy = false), 260); } }
  }, { passive: false });
  let wheelBusy = false;

  const onKey = (e) => {
    if (e.target.closest?.('input,textarea')) return;
    const k = e.key;
    if (k === 'ArrowRight') turn(1); else if (k === 'ArrowLeft') turn(-1);
    else if (k === 'ArrowDown' && mode === 'scroll') step(1);
    else if (k === ' ' || k === 'PageDown') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (k === 'PageUp') step(-1);
    else if (k === 'Home') goPage(0); else if (k === 'End') goPage(N - 1);
    else if (k === '+' || k === '=') zoomBy(1.4); else if (k === '-') zoomBy(1 / 1.4);
    else if (k === 'f') toggleFullscreen();
    else if (k === 'r') rotate();
  };
  addEventListener('keydown', onKey);
  function zoomBy(f) { if (mode === 'scroll') return; zoom = clamp(zoom * f, 1, MAX_ZOOM); if (zoom === 1) tx = ty = 0; if (spreadEl) { spreadEl.style.transition = 'transform .2s'; place(); } }
  function rotate() { rot = (rot + 90) % 360; layout(); }
  function toggleFullscreen() {
    if (!document.fullscreenEnabled) { toast('Fullscreen isn’t available here'); return; }
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  /* ---------- initial layout ---------- */
  vw = host.clientWidth || innerWidth; vh = host.clientHeight || innerHeight;
  await layout(cur);

  /* ---------- controller ---------- */
  const chapters = (src.info?.pages || []).filter((p) => p.type || p.bookmark).map((p) => ({ label: p.bookmark || p.type, location: { page: p.image }, depth: 0 }));

  const ctl = {
    kind: 'comic',
    toc: chapters,
    goTo: (loc) => goPage(typeof loc === 'number' ? loc : loc?.page ?? 0),
    next: () => step(1), prev: () => step(-1),
    seek: (f) => goPage(f * (N - 1)),
    seekLabel: (f) => `Page ${Math.round(f * (N - 1)) + 1} of ${N}`,
    here: () => ({ location: { page: spreadPages[0] }, progress: N > 1 ? spreadPages[0] / (N - 1) : 1 }),
    isVisible: (loc) => spreadPages.includes(typeof loc === 'number' ? loc : loc?.page),
    bookmarkTitle: () => `Page ${spreadPages[0] + 1}`,
    pageInfo,
    tocIndex: () => { let k = -1; chapters.forEach((c, i) => { if (c.location.page <= spreadPages[0]) k = i; }); return k >= 0 ? k : null; },
    thumbs: { count: N, current: () => spreadPages[0], aspect: '2/3', location: (i) => ({ page: i }), render: async (i) => thumbFromBlob(await src.getBlob(i), 200, 0.7) },
    onChrome() {},
    settingsPanel() {
      const wrap = h('div', null);
      const readingDir = segmented([{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left (manga)' }], rtl() ? 'rtl' : 'ltr', (v) => { prefs.rtl = v === 'rtl'; savePrefs(); report(false); if (mode === 'double') layout(); });
      const modeSeg = segmented([{ value: 'auto', label: 'Auto' }, { value: 'single', label: 'Single', icon: 'single' }, { value: 'double', label: 'Double' }, { value: 'scroll', label: 'Scroll', icon: 'scroll' }], modeSetting(), (v) => { prefs.mode = v; savePrefs(); layout(); }, { wrap: true });
      const bright = slider({ label: 'Brightness', min: 0.5, max: 1.5, step: 0.05, value: S().brightness, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { settings.set('comic.brightness', v); applyFilters(); } });
      const contr = slider({ label: 'Contrast', min: 0.5, max: 1.6, step: 0.05, value: S().contrast, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { settings.set('comic.contrast', v); applyFilters(); } });
      const widthCtl = slider({ label: 'Scroll width', min: 60, max: 160, step: 10, value: prefs.scrollWidth || 100, format: (v) => v + '%', onInput: debounce((v) => { prefs.scrollWidth = v; savePrefs(); if (mode === 'scroll') layout(); }, 150) });
      wrap.append(
        group('Layout', field('Page mode', modeSeg), field('Reading direction', readingDir, 'Saved for this comic.'),
          toggleRow({ label: 'Cover on its own page', hint: 'In double-page mode', value: S().firstPageAlone, onChange: (v) => { settings.set('comic.firstPageAlone', v); if (mode === 'double') layout(); } }),
          widthCtl),
        group('Image', bright, contr,
          toggleRow({ label: 'Sharpen', hint: 'Crisper line art on small screens', value: S().sharpen, onChange: (v) => { settings.set('comic.sharpen', v); applyFilters(); } }),
          toggleRow({ label: 'Trim margins', hint: 'Crops empty borders around each page', value: S().trim, onChange: (v) => { settings.set('comic.trim', v); for (let i = 0; i < N; i++) if (pages[i]) drop(i); layout(); } }),
          h('div', { style: { display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } },
            h('button', { class: 'btn ghost', onclick: rotate }, icon('rotate', 18), 'Rotate'),
            document.fullscreenEnabled ? h('button', { class: 'btn ghost', onclick: toggleFullscreen }, icon('fullscreen', 18), 'Fullscreen') : null,
            h('button', { class: 'btn ghost', onclick: () => { settings.set('comic.brightness', 1); settings.set('comic.contrast', 1); settings.set('comic.sharpen', false); bright.set(1); contr.set(1); applyFilters(); } }, 'Reset image'))));
      return wrap;
    },
    destroy() {
      destroyed = true;
      removeEventListener('keydown', onKey);
      ro.disconnect(); io?.disconnect();
      for (let i = 0; i < N; i++) if (pages[i]?.url) URL.revokeObjectURL(pages[i].url);
      src.close();
      host.replaceChildren();
    },
  };
  return ctl;
}
