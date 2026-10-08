/* INK — EPUB engine.
 *
 *  Paged  : one chapter part at a time laid out in CSS columns; the neighbouring parts sit ready beside it,
 *           so a swipe drags the real next page under your finger (no blank flashes, no re-layout per turn).
 *  Scroll : chapters stacked in one continuous column, loaded on demand in both directions.
 *
 *  Locations are character offsets inside a chapter  { s: chapterIndex, f: 0‥1, a: charOffset }
 *  so bookmarks, highlights, search hits and "resume where I left off" survive any typography change.
 */
import { h, clamp, debounce, sleep, idle, fmtMinutes } from './ink-util.js';
import * as settings from './ink-settings.js';
import * as db from './ink-db.js';
import { openZip } from './ink-zip.js';
import { loadEpubPackage, loadEpubToc, mimeOf, fragmentOf } from './ink-meta.js';
import { loadSection, attachImages, findById, offsetIn, pointAt, wrapChars, unwrapAll, hasMedia, sectionText, snippetOf } from './ink-epub-content.js';
import { showSelBar } from './ink-selbar.js';
import { hlColor } from './ink-reader.js';
import { segmented, slider, toggleRow, field, group, swatches, toast, promptDialog, confirmDialog, motionOK, topSheet } from './ink-ui.js';

const WPM = 230, CHARS_PER_WORD = 5.7;
const RELAYOUT_KEYS = new Set(['reading.font', 'reading.size', 'reading.lineHeight', 'reading.letterSpacing', 'reading.wordSpacing', 'reading.firstLineIndent', 'reading.paraSpacing', 'reading.margin', 'reading.align', 'reading.columnWidth', 'reading.flow', 'app.dyslexia']);
const THEME_KEYS = new Set(['reading.theme', 'reading.customBg', 'reading.customFg', 'app.theme', 'app.system']);

export async function open({ book, blob, host, api, saved, gotoQuery }) {
  const zip = await openZip(blob);
  const pkg = await loadEpubPackage(zip);
  const spine = pkg.spine.filter((it) => zip.has(it.href));
  if (!spine.length) throw Object.assign(new Error('This EPUB has no readable chapters.'), { code: 'empty' });
  const hrefToS = new Map(spine.map((it, i) => [it.href, i]));
  const sizes = spine.map((it) => Math.max(1, zip.find(it.href)?.size || 1));
  const cum = []; let TOTAL = 0; for (const z of sizes) { cum.push(TOTAL); TOTAL += z; }
  const rtlBook = !!pkg.rtl || /^(ar|he|fa|ur|yi)\b/i.test(pkg.language || '');
  const nx = rtlBook ? -1 : 1;                       // screen direction of "next" (+1 = to the right)
  let bookPrefs = book.readingPrefs || null;
  const R = () => settings.effectiveReading(bookPrefs);
  const flowMode = () => (R().flow === 'scroll' ? 'scroll' : 'paged');
  let destroyed = false;
  const setBookPref = async (key, value) => {
    bookPrefs = { ...(bookPrefs || {}), [key]: value };
    book.readingPrefs = bookPrefs;
    try { const { saveReadingPrefs } = await import('./ink-lib.js'); await saveReadingPrefs(book.id, { [key]: value }); } catch { /* ignore */ }
  };

  /* ---------- DOM ---------- */
  const view = h('div', { class: 'ep-view' });
  const pagesEl = h('div', { class: 'ep-pages' });
  const hudChapter = h('span'), hudPage = h('span'), hudPct = h('span');
  const hudT = h('div', { class: 'ep-hud t' }, hudChapter, h('span'));
  const hudB = h('div', { class: 'ep-hud b' }, hudPage, hudPct);
  const probeEl = h('div', { style: { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', paddingTop: 'var(--st)', paddingBottom: 'var(--sb)' } });
  const root = h('div', { class: 'ep' }, view, hudT, hudB, probeEl);
  host.replaceChildren(root);

  function applyVars() {
    const r = R(), t = settings.readingThemeFor(r), st = root.style;
    st.setProperty('--ep-bg', t.bg); st.setProperty('--ep-fg', t.fg); st.setProperty('--ep-link', t.link);
    st.setProperty('--ep-font', settings.readingFontStack(r));
    st.setProperty('--ep-size', String(r.size)); st.setProperty('--ep-lh', String(r.lineHeight));
    st.setProperty('--ep-ls', String(r.letterSpacing)); st.setProperty('--ep-ws', String(r.wordSpacing || 0));
    st.setProperty('--ep-indent', String(r.firstLineIndent || 0));
    st.setProperty('--ep-align', r.align);
    st.setProperty('--ep-para', String(r.paraSpacing)); st.setProperty('--ep-m', r.margin + 'px');
    host.style.setProperty('--rd-bg', t.bg);
  }
  applyVars();

  /* ---------- geometry ---------- */
  let geo = { VW: 0, VH: 0, W: 0, H: 0, left: 0, top: 0, G: 0, step: 1, st: 0, sb: 0 };
  function measureGeo() {
    const VW = root.clientWidth || host.clientWidth || innerWidth, VH = root.clientHeight || host.clientHeight || innerHeight;
    const cs = getComputedStyle(probeEl);
    const st = parseFloat(cs.paddingTop) || 0, sb = parseFloat(cs.paddingBottom) || 0;
    const m = R().margin;
    const W = Math.max(180, Math.min(VW - 2 * m, R().columnWidth));
    const left = Math.round((VW - W) / 2);
    // Reserve space so text never sits under floating chrome (FABs ~52px, seek ~64px)
    const chromePadT = 56, chromePadB = 72;
    const top = Math.round(st + chromePadT), bottom = Math.round(sb + chromePadB);
    const H = Math.max(160, VH - top - bottom);
    const G = left + 24;
    geo = { VW, VH, W, H, left, top, G, step: W + G, st, sb };
    root.style.setProperty('--ep-ph', String(H - 10));
  }
  measureGeo();

  /* ---------- sections, images ---------- */
  const cssCache = new Map(), secCache = new Map(), loadedSecs = new Map(), imgUrls = new Map(), partMap = new WeakMap(), textCache = new Map();
  let ratioNum = 0, ratioDen = 0;
  const urlFor = (p) => {
    if (!imgUrls.has(p)) imgUrls.set(p, (async () => { if (!zip.has(p)) return ''; return URL.createObjectURL(await zip.blob(p, mimeOf(p))); })().catch(() => ''));
    return imgUrls.get(p);
  };
  function getSec(s) {
    if (secCache.has(s)) return secCache.get(s);
    const p = (async () => {
      const sec = await loadSection(zip, spine[s], s, cssCache);
      await attachImages(sec, urlFor);
      sec.parts.forEach((part) => partMap.set(part.el, { sec, part }));
      loadedSecs.set(s, sec);
      ratioNum += sec.total; ratioDen += sizes[s];
      return sec;
    })();
    secCache.set(s, p);
    p.catch(() => secCache.delete(s));
    return p;
  }
  function evict(keepLo, keepHi) {
    for (const s of [...secCache.keys()]) if (s < keepLo - 2 || s > keepHi + 2) { secCache.delete(s); loadedSecs.delete(s); }
  }
  const partIndexAt = (sec, off) => { let k = 0; for (let i = 0; i < sec.parts.length; i++) if (sec.parts[i].base <= off) k = i; return k; };
  const targetOffset = (sec, t) => (t.a != null ? clamp(t.a, 0, sec.total) : Math.round(clamp(t.f ?? 0, 0, 1) * sec.total));

  /* ---------- table of contents ---------- */
  let tocFlat = [];
  const tocP = (async () => {
    const items = await loadEpubToc(zip, pkg).catch(() => []);
    const out = [];
    for (const it of items) {
      if (!it.href) continue;
      const s = hrefToS.get(it.href.split('#')[0]);
      if (s == null) continue;
      const id = fragmentOf(it.href);
      out.push({
        label: it.label,
        depth: it.level || 0,
        s,
        id,
        source: it.source || 'nav',
        location: { s, f: 0, id: id || undefined },
      });
    }
    for (let i = 0; i < out.length; i++) {
      out[i].hasChildren = i + 1 < out.length && out[i + 1].depth > out[i].depth;
    }
    tocFlat = out;
    return out;
  })();
  function anchorChar(e) {
    if (!e.id) return 0;
    if (e._a != null) return e._a;
    const sec = loadedSecs.get(e.s); if (!sec) return 0;
    const hit = findById(sec, e.id);
    if (!hit?.el) return (e._a = 0);
    const part = sec.parts[hit.part];
    return (e._a = part.base + offsetIn(part.el, hit.el, 0));
  }
  function chapterIndexAt(s, a) {
    let best = -1, bs = -1, ba = -1;
    for (let i = 0; i < tocFlat.length; i++) {
      const e = tocFlat[i];
      if (e.s > s) continue;
      const ac = e.s === s ? anchorChar(e) : 0;
      if (e.s === s && ac > a) continue;
      if (e.s > bs || (e.s === bs && ac >= ba)) { best = i; bs = e.s; ba = ac; }
    }
    return best;
  }
  const chapterAt = (s, a) => tocFlat[chapterIndexAt(s, a)] || null;

  /* ---------- highlights ---------- */
  let hls = await db.listHighlights(book.id);
  function renderMarks(sec, part) {
    unwrapAll(part.el, 'mark.hl');
    for (const m of hls) {
      const L = m.location;
      if (!L || L.s !== sec.s || L.a == null) continue;
      const from = Math.max(L.a - part.base, 0), to = Math.min(L.b - part.base, part.chars);
      if (to <= from) continue;
      wrapChars(part.el, from, to, () => h('mark', { class: 'hl' + (m.note ? ' note' : ''), 'data-id': m.id, style: { '--hl': hlColor(m.color) } }));
    }
  }
  const mountedParts = () => {
    const out = [];
    if (flowMode() === 'paged') {
      for (const u of [units.prev, units.cur, units.next]) if (u) out.push([u.sec, u.part]);
    } else {
      for (const body of secBodies.values()) { const sec = loadedSecs.get(+body.dataset.s); if (sec) sec.parts.forEach((p) => out.push([sec, p])); }
    }
    return out;
  };
  const rerenderAllMarks = () => mountedParts().forEach(([sec, part]) => renderMarks(sec, part));

  /* ---------- search highlight ---------- */
  const findParts = new Set(); let findT = 0;
  function clearFind() { clearTimeout(findT); for (const el of findParts) unwrapAll(el, 'mark.find'); findParts.clear(); }
  function markFind({ s, a, n }) {
    const sec = loadedSecs.get(s); if (!sec || a == null || !n) return;
    const part = sec.parts[partIndexAt(sec, a)];
    wrapChars(part.el, a - part.base, Math.min(part.chars, a - part.base + n), () => h('mark', { class: 'find' }));
    findParts.add(part.el);
    findT = setTimeout(clearFind, 9000);
  }

  /* ============================================================ PAGED ============================================================ */
  let units = { prev: null, cur: null, next: null };
  let busy = false, showToken = 0, nbToken = 0, nbPromise = null, settleT = 0;
  let lastPos = null;                                  // { s, a, e } visible character range
  const slotOffset = (role) => (role === 'cur' ? 0 : role === 'next' ? nx * geo.VW : -nx * geo.VW);

  async function makeUnit(s, p) {
    const sec = await getSec(s);
    p = clamp(p, 0, sec.parts.length - 1);
    const part = sec.parts[p];
    const slot = h('div', { class: 'ep-slot' });
    const body = h('div', { class: 'ep-body cols', 'data-s': s, lang: sec.lang || pkg.language || null, dir: rtlBook ? 'rtl' : null });
    if (sec.css) slot.append(h('style', null, sec.css));
    body.append(part.el);
    slot.append(body);
    const u = { s, p, sec, part, slot, body, pages: 1, page: 0, role: '' };
    slot.addEventListener('load', () => scheduleRemeasure(u), true);
    return u;
  }
  function placeUnit(u, role) {
    u.role = role;
    u.slot.style.transform = `translate3d(${slotOffset(role)}px,0,0)`;
    if (!u.slot.isConnected) pagesEl.append(u.slot);
  }
  function sizeUnit(u) {
    const g = geo;
    u.body.style.cssText = `left:${g.left}px;top:${g.top}px;width:${g.W}px;height:${g.H}px;column-width:${g.W}px;column-gap:${g.G}px;`;
    u.pages = measurePages(u);
  }
  function disposeUnit(u) {
    if (!u) return;
    u.dead = true;
    try { unwrapAll(u.part.el, 'mark'); } catch { /* ignore */ }
    u.slot.remove();
  }
  const colOf = (u, rect, b = u.body.getBoundingClientRect()) => {
    const d = nx > 0 ? rect.left - b.left : b.right - rect.right;
    return Math.max(0, Math.floor((d + 1) / geo.step));
  };
  function lastContentRect(u) {
    const el = u.part.el;
    let n = el; while (n.lastChild) n = n.lastChild;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    tw.currentNode = n;
    let cur = n;
    for (let guard = 0; cur && guard < 4000; guard++) {
      if (cur.nodeType === 3 && /\S/.test(cur.data)) {
        const r = document.createRange(); r.setStart(cur, Math.max(0, cur.data.search(/\S\s*$/))); r.setEnd(cur, cur.data.length);
        const rects = r.getClientRects();
        if (rects.length) return rects[rects.length - 1];
      } else if (cur.nodeType === 1 && /^(img|svg|image|table|hr)$/i.test(cur.localName)) {
        const r = cur.getBoundingClientRect();
        if (r.width || r.height) return r;
      }
      cur = tw.previousNode();
    }
    return null;
  }
  function measurePages(u) {
    const r = lastContentRect(u);
    return r ? colOf(u, r) + 1 : 1;
  }
  function pageOfOffset(u, local) {
    const pt = pointAt(u.part.el, clamp(local, 0, u.part.chars));
    if (pt) {
      const len = pt.node.data.length, a = Math.min(pt.off, Math.max(0, len - 1));
      const r = document.createRange(); r.setStart(pt.node, a); r.setEnd(pt.node, Math.min(len, a + 1));
      const rects = r.getClientRects();
      if (rects.length && (rects[0].width || rects[0].height)) return colOf(u, rects[0]);
    }
    return Math.min(u.pages - 1, Math.floor((local / Math.max(1, u.part.chars)) * u.pages));
  }
  function pageOfEl(u, el) {
    const rects = el.getClientRects();
    const r = rects.length ? rects[0] : el.getBoundingClientRect();
    if (!r.width && !r.height) return 0;
    return colOf(u, r);
  }
  function setPageTransform(u, k, animate, dx = 0) {
    u.body.style.transition = animate && motionOK() ? 'transform .28s cubic-bezier(.22,.82,.18,1)' : 'none';
    u.body.style.transform = `translate3d(${-nx * k * geo.step + dx}px,0,0)`;
  }
  async function waitImages(el, ms = 700) {
    const imgs = [...el.querySelectorAll('img')].filter((i) => i.src && !i.complete).slice(0, 8);
    if (!imgs.length) return;
    await Promise.race([Promise.all(imgs.map((i) => i.decode().catch(() => {}))), sleep(ms)]);
  }

  /** character range currently on screen (paged) — measured from layout, so overlays can't confuse it */
  function probe(u) {
    const b = u.body.getBoundingClientRect();
    const startOf = (k) => (k <= 0 ? 0 : k >= u.pages ? u.part.chars : firstCharWhere(u.part.el, (r) => colOf(u, r, b) >= k, u.part.chars));
    const a = startOf(u.page), e = startOf(u.page + 1);
    return { a: u.part.base + a, e: u.part.base + Math.max(a, e) };
  }

  /* ---------- reporting ---------- */
  const ratio = () => (ratioDen ? ratioNum / ratioDen : 0.5);
  function report(turned = false) {
    if (destroyed) return;
    let s, a, e, sec, atEnd = false, pageText = '';
    if (flowMode() === 'paged') {
      const u = units.cur; if (!u) return;
      const p = probe(u);
      s = u.s; a = p.a; e = p.e; sec = u.sec;
      atEnd = s === spine.length - 1 && u.p === sec.parts.length - 1 && u.page >= u.pages - 1;
      if (sec.parts.length === 1) pageText = `${u.page + 1} / ${u.pages}`;
    } else {
      const p = probeScroll(); if (!p) return;
      ({ s, a, e, sec, atEnd } = p);
    }
    lastPos = { s, a, e };
    const fS = sec.total ? a / sec.total : 0, fE = sec.total ? Math.min(1, e / sec.total) : 1;
    let progress = (cum[s] + sizes[s] * fE) / TOTAL;
    if (atEnd) progress = 1;
    const ch = chapterAt(s, Math.round(a + (e - a) * 0.2));
    const mins = (TOTAL * ratio() * (1 - progress)) / (WPM * CHARS_PER_WORD);
    const label = ch?.label || book.title;
    // Engine HUD disabled — reader chrome owns progress display (avoids double labels)
    hudT.style.display = 'none';
    hudB.style.display = 'none';
    const showTime = R().showTimeLeft !== false;
    const sub = progress >= 1 ? `${Math.round(progress * 100)}% · finished`
      : showTime ? `${Math.round(progress * 100)}% · ${fmtMinutes(mins)} left`
      : `${Math.round(progress * 100)}%`;

    // "N pages left in chapter" for the floating top status
    let chapLeft = '';
    const chIdx = chapterIndexAt(s, Math.round(a + (e - a) * 0.2));
    if (chIdx >= 0 && tocFlat.length) {
      const start = tocFlat[chIdx];
      const next = tocFlat[chIdx + 1];
      const startByte = cum[start.s];
      const endByte = next ? cum[next.s] : TOTAL;
      const hereByte = cum[s] + sizes[s] * fE;
      const leftBytes = Math.max(0, endByte - hereByte);
      const pagesLeft = Math.max(0, Math.round((leftBytes * ratio()) / (WPM * CHARS_PER_WORD * 1.35)));
      chapLeft = progress >= 1 ? 'Finished'
        : pagesLeft > 0 ? `${pagesLeft} page${pagesLeft === 1 ? '' : 's'} left in chapter`
        : (ch?.label || '');
    }
    const pageLabel = pageText || `${Math.round(progress * 100)}%`;
    api.relocate({ location: { s, f: +fS.toFixed(5), a }, progress, label, sub, turned, chapLeft, pageLabel });
  }

  /** Approximate progress (0–1) for a TOC entry relative to the next entry / end of book */
  function chapterProgress(idx) {
    if (!tocFlat.length || idx < 0 || idx >= tocFlat.length) return 0;
    const e = tocFlat[idx];
    const startByte = cum[e.s] + sizes[e.s] * 0; // chapter start ≈ section start (anchors resolved lazily)
    const next = tocFlat[idx + 1];
    const endByte = next ? cum[next.s] : TOTAL;
    const span = Math.max(1, endByte - startByte);
    if (!lastPos) return 0;
    const here = cum[lastPos.s] + sizes[lastPos.s] * (loadedSecs.get(lastPos.s)?.total ? lastPos.a / loadedSecs.get(lastPos.s).total : 0);
    if (here < startByte) return 0;
    if (here >= endByte) return 1;
    return clamp((here - startByte) / span, 0, 1);
  }
  const reportSoon = debounce(() => report(true), 40);
  function afterTurn() {
    clearTimeout(settleT);
    const u = units.cur;
    if (u && flowMode() === 'paged') hudPage.textContent = u.sec.parts.length === 1 ? `${u.page + 1} / ${u.pages}` : '';
    settleT = setTimeout(() => report(true), motionOK() ? 260 : 20);
  }

  /* ---------- showing a location ---------- */
  async function pagedShow(t, find) {
    const token = ++showToken;
    const sec = await getSec(t.s);
    if (destroyed || token !== showToken) return;
    let pi = 0, off = 0, idHit = null;
    if (t.id) idHit = findById(sec, t.id);
    if (idHit?.el) pi = idHit.part; else { off = targetOffset(sec, t); pi = partIndexAt(sec, off); }
    const old = [units.prev, units.cur, units.next];
    units = { prev: null, cur: null, next: null }; nbToken++;
    old.forEach(disposeUnit);
    const u = await makeUnit(t.s, pi);
    if (destroyed || token !== showToken) return;
    placeUnit(u, 'cur'); sizeUnit(u); renderMarks(sec, u.part);
    await waitImages(u.part.el);
    u.pages = measurePages(u);
    const page = idHit?.el ? pageOfEl(u, idHit.el) : pageOfOffset(u, off - u.part.base);
    u.page = clamp(page, 0, u.pages - 1);
    setPageTransform(u, u.page, false);
    units.cur = u;
    clearFind(); if (find) markFind(find);
    report(false);
    evict(t.s - 3, t.s + 3);
    fillNeighbors();
  }

  async function neighborKey(u, dir) {
    let s = u.s, p = u.p, sec = u.sec;
    for (let guard = 0; guard < 60; guard++) {
      if (dir > 0) {
        if (p + 1 < sec.parts.length) p++;
        else { s++; if (s >= spine.length) return null; sec = await getSec(s); p = 0; }
      } else if (p > 0) p--;
      else { s--; if (s < 0) return null; sec = await getSec(s); p = sec.parts.length - 1; }
      const part = sec.parts[p];
      if (part.chars > 0 || hasMedia(part)) return { s, p };
    }
    return null;
  }
  function fillNeighbors() {
    const tok = ++nbToken;
    nbPromise = (async () => {
      const cu = units.cur; if (!cu) return;
      for (const [role, dir] of [['next', 1], ['prev', -1]]) {
        if (tok !== nbToken || destroyed) return;
        let key; try { key = await neighborKey(cu, dir); } catch { key = null; }
        if (tok !== nbToken || destroyed) return;
        const have = units[role];
        if (!key) continue;
        if (have && have.s === key.s && have.p === key.p) continue;
        disposeUnit(have); units[role] = null;
        let u; try { u = await makeUnit(key.s, key.p); } catch { continue; }
        if (tok !== nbToken || destroyed) { disposeUnit(u); return; }
        placeUnit(u, role); sizeUnit(u); renderMarks(u.sec, u.part);
        await waitImages(u.part.el, 250);
        u.pages = measurePages(u);
        u.page = role === 'prev' ? u.pages - 1 : 0;
        setPageTransform(u, u.page, false);
        units[role] = u;
        await sleep(0);
      }
    })();
    return nbPromise;
  }
  const scheduleRemeasure = debounce((u) => {
    if (u.dead || destroyed || busy) return;
    if (u === units.cur) {
      const anchor = lastPos ? lastPos.a - u.part.base : 0;
      const before = u.pages;
      u.pages = measurePages(u);
      const k = clamp(pageOfOffset(u, anchor), 0, u.pages - 1);
      if (u.pages !== before || k !== u.page) { u.page = k; setPageTransform(u, k, false); report(false); }
    } else {
      u.pages = measurePages(u);
      if (u.role === 'prev') { u.page = u.pages - 1; setPageTransform(u, u.page, false); }
    }
  }, 140);

  /* ---------- turning ---------- */
  const waitEnd = (el, ms) => new Promise((res) => {
    if (!ms) return res();
    let done = false;
    const f = (e) => { if (e && e.target !== el) return; if (done) return; done = true; el.removeEventListener('transitionend', f); res(); };
    el.addEventListener('transitionend', f);
    setTimeout(() => f(null), ms + 90);
  });
  function snapBack() {
    pagesEl.style.transition = 'transform .2s ease'; pagesEl.style.transform = 'none';
    const u = units.cur; if (u) setPageTransform(u, u.page, true);
  }
  async function turn(dir) {
    api.interaction();
    clearFind();
    if (flowMode() === 'scroll') { scroller?.scrollBy({ top: dir * scroller.clientHeight * 0.88, behavior: motionOK() ? 'smooth' : 'auto' }); return true; }
    const u = units.cur; if (!u || busy) return false;
    const k = u.page + dir;
    if (k >= 0 && k < u.pages) { u.page = k; setPageTransform(u, k, true); afterTurn(); return true; }
    let target = dir > 0 ? units.next : units.prev;
    if (!target && nbPromise) { await nbPromise; target = dir > 0 ? units.next : units.prev; }
    if (!target) { snapBack(); if (dir > 0) toast('You’ve reached the end'); return false; }
    // Optional: stop at chapter boundary and offer Continue
    if (dir > 0 && R().chapterStop && lastPos) {
      const curCh = chapterIndexAt(lastPos.s, lastPos.a);
      const nextA = target.part?.base ?? 0;
      const nextCh = chapterIndexAt(target.s, nextA);
      if (nextCh > curCh && curCh >= 0) {
        snapBack();
        const nxt = tocFlat[nextCh];
        const label = nxt?.label || 'next chapter';
        if (await confirmDialog({ title: 'End of chapter', message: `Continue to “${label}”?`, confirmLabel: 'Continue', cancelLabel: 'Stay' })) {
          goTo(nxt?.location || { s: target.s, f: 0 });
        }
        return false;
      }
    }
    busy = true;
    target.page = dir > 0 ? 0 : target.pages - 1;
    setPageTransform(target, target.page, false);
    // Premium page-turn: springy slide with subtle depth on the leaving page
    const dur = motionOK() ? 320 : 0;
    if (units.cur?.slot) {
      units.cur.slot.style.transition = dur ? `box-shadow ${dur}ms ease, transform ${dur}ms cubic-bezier(.22,.8,.2,1)` : 'none';
      units.cur.slot.style.boxShadow = dir > 0
        ? '-12px 0 28px rgba(0,0,0,.22)' : '12px 0 28px rgba(0,0,0,.22)';
    }
    pagesEl.style.transition = dur ? `transform ${dur}ms cubic-bezier(.22,.82,.18,1)` : 'none';
    pagesEl.style.transform = `translate3d(${-dir * nx * geo.VW}px,0,0)`;
    await waitEnd(pagesEl, dur);
    if (destroyed) return false;
    if (units.cur?.slot) { units.cur.slot.style.boxShadow = ''; units.cur.slot.style.transition = ''; }
    pagesEl.style.transition = 'none'; pagesEl.style.transform = 'none';
    if (dir > 0) { disposeUnit(units.prev); units = { prev: units.cur, cur: target, next: null }; }
    else { disposeUnit(units.next); units = { next: units.cur, cur: target, prev: null }; }
    for (const r of ['prev', 'cur', 'next']) if (units[r]) placeUnit(units[r], r);
    busy = false;
    report(true);
    evict(units.cur.s - 3, units.cur.s + 3);
    fillNeighbors();
    return true;
  }

  /* ============================================================ SCROLL ============================================================ */
  let scroller = null, flowEl = null;
  const secBodies = new Map();
  let scrollBusy = false;

  function chapterLabelForSection(s) {
    // Prefer a TOC entry that starts at this spine index
    const hit = tocFlat.find((t) => t.s === s && (!t.id || t.depth === 0));
    if (hit?.label) return hit.label;
    const any = tocFlat.find((t) => t.s === s);
    return any?.label || '';
  }

  async function mountSection(s, where) {
    if (secBodies.has(s)) return secBodies.get(s);
    const sec = await getSec(s);
    if (destroyed || !flowEl) return null;
    if (secBodies.has(s)) return secBodies.get(s);
    const body = h('div', { class: 'ep-body sec' + (sec.parts.length === 1 ? ' single' : ''), 'data-s': s, lang: sec.lang || pkg.language || null, dir: rtlBook ? 'rtl' : null });
    body.style.width = geo.W + 'px';
    if (sec.css) body.append(h('style', null, sec.css));
    // Visual chapter break before every section after the first — clean Apple Books–style separation
    if (s > 0) {
      const label = chapterLabelForSection(s);
      const br = h('div', { class: 'ep-chap-break', 'aria-hidden': label ? 'false' : 'true' },
        label ? h('div', { class: 'ep-chap-title' }, label) : null);
      body.append(br);
    }
    sec.parts.forEach((p) => body.append(p.el));
    sec.parts.forEach((p) => renderMarks(sec, p));
    if (where === 'start') { const h0 = scroller.scrollHeight; flowEl.prepend(body); scroller.scrollTop += scroller.scrollHeight - h0; }
    else flowEl.append(body);
    secBodies.set(s, body);
    body.addEventListener('load', () => scheduleScrollRemeasure(), true);
    return body;
  }
  const scheduleScrollRemeasure = debounce(() => { if (!destroyed && scroller) report(false); }, 160);

  function rectOfOffset(sec, off) {
    const part = sec.parts[partIndexAt(sec, off)];
    const pt = pointAt(part.el, off - part.base);
    if (!pt) return null;
    const len = pt.node.data.length, a = Math.min(pt.off, Math.max(0, len - 1));
    const r = document.createRange(); r.setStart(pt.node, a); r.setEnd(pt.node, Math.min(len, a + 1));
    const rects = r.getClientRects();
    return rects.length ? rects[0] : null;
  }
  async function alignScroll(t) {
    const sec = await getSec(t.s);
    const body = secBodies.get(t.s); if (!body || !scroller) return;
    body.classList.add('measure');
    let rect = null;
    if (t.id) rect = findById(sec, t.id)?.el?.getBoundingClientRect() || null;
    if (!rect && (t.a != null || (t.f ?? 0) > 0)) rect = rectOfOffset(sec, targetOffset(sec, t));
    if (rect) scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - geo.top + 4;
    else scroller.scrollTop = 0;
    requestAnimationFrame(() => body.classList.remove('measure'));
  }
  async function scrollShow(t, find) {
    const token = ++showToken;
    flowEl.replaceChildren(); secBodies.clear(); scroller.scrollTop = 0;
    const body = await mountSection(t.s, 'end');
    if (destroyed || token !== showToken || !body) return;
    await waitImages(body, 600);
    await alignScroll(t);
    clearFind(); if (find) markFind(find);
    report(false);
    idle(() => topUp(), 800);
  }
  async function topUp() {
    if (scrollBusy || destroyed || !scroller) return;
    scrollBusy = true;
    try {
      const vh = scroller.clientHeight;
      const keys = [...secBodies.keys()].sort((a, b) => a - b);
      if (!keys.length) return;
      if (scroller.scrollTop + vh > scroller.scrollHeight - vh * 1.5 && keys[keys.length - 1] + 1 < spine.length) await mountSection(keys[keys.length - 1] + 1, 'end');
      if (scroller.scrollTop < vh * 1.5 && keys[0] > 0) await mountSection(keys[0] - 1, 'start');
      // keep the DOM small
      const ks = [...secBodies.keys()].sort((a, b) => a - b);
      const cur = lastPos?.s ?? ks[0];
      while (ks.length > 4) {
        const far = Math.abs(ks[0] - cur) >= Math.abs(ks[ks.length - 1] - cur) ? ks.shift() : ks.pop();
        const b = secBodies.get(far); if (!b) continue;
        const before = scroller.scrollHeight;
        const sec = loadedSecs.get(far);
        sec?.parts.forEach((p) => unwrapAll(p.el, 'mark'));
        b.remove(); secBodies.delete(far);
        if (far < cur) scroller.scrollTop -= before - scroller.scrollHeight;
      }
      evict((lastPos?.s ?? 0) - 3, (lastPos?.s ?? 0) + 3);
    } finally { scrollBusy = false; }
  }
  const onScroll = debounce(() => { topUp(); report(true); }, 120);
  function probeScroll() {
    if (!scroller || !flowEl) return null;
    const sr = scroller.getBoundingClientRect();
    const T = sr.top + geo.top, B = sr.bottom - geo.sb - 12;
    let start = null, end = null;
    outer:
    for (const body of flowEl.children) {
      const sec = loadedSecs.get(+body.dataset.s); if (!sec) continue;
      for (const part of sec.parts) {
        const pr = part.el.getBoundingClientRect();
        if (pr.bottom <= T) continue;
        if (!start) {
          const a = firstCharWhere(part.el, (r) => r.bottom > T + 2, part.chars);
          start = { s: sec.s, sec, a: part.base + a };
        }
        if (pr.top >= B) { if (!end) end = { s: sec.s, a: part.base }; break outer; }
        if (pr.bottom > B) { const e = firstCharWhere(part.el, (r) => r.top >= B, part.chars); end = { s: sec.s, a: part.base + e }; break outer; }
      }
    }
    if (!start) return lastPos && loadedSecs.get(lastPos.s) ? { s: lastPos.s, a: lastPos.a, e: lastPos.e, sec: loadedSecs.get(lastPos.s), atEnd: false } : null;
    const e = end && end.s === start.s ? end.a : end && end.s > start.s ? start.sec.total : start.sec.total;
    const atEnd = start.s === spine.length - 1 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 6;
    return { s: start.s, a: start.a, e: Math.max(e, start.a), sec: start.sec, atEnd };
  }

  /* ============================================================ BUILD / REBUILD ============================================================ */
  async function build(pos, find) {
    clearFind();
    for (const u of [units.prev, units.cur, units.next]) disposeUnit(u);
    units = { prev: null, cur: null, next: null }; nbToken++;
    for (const b of secBodies.values()) { const sec = loadedSecs.get(+b.dataset.s); sec?.parts.forEach((p) => unwrapAll(p.el, 'mark')); }
    secBodies.clear(); scroller = null; flowEl = null;
    measureGeo();
    if (flowMode() === 'scroll') {
      view.replaceChildren();
      view.style.touchAction = 'auto';
      scroller = h('div', { class: 'ep-scroll' });
      scroller.style.overflowAnchor = 'none';
      // Keep text clear of the HUD labels and home indicator
      scroller.style.paddingTop = Math.max(28, geo.top) + 'px';
      scroller.style.paddingBottom = Math.max(48, geo.sb + 56) + 'px';
      flowEl = h('div', { class: 'ep-flow' });
      flowEl.style.margin = '0 auto';
      flowEl.style.maxWidth = geo.W + 'px';
      scroller.append(flowEl);
      view.append(scroller);
      scroller.addEventListener('scroll', onScroll, { passive: true });
      await scrollShow(pos, find);
    } else {
      view.replaceChildren(pagesEl);
      view.style.touchAction = 'none';
      pagesEl.style.transition = 'none'; pagesEl.style.transform = 'none'; pagesEl.replaceChildren();
      await pagedShow(pos, find);
    }
  }
  const goToInternal = (t, find) => (flowMode() === 'scroll' ? scrollShow(t, find) : pagedShow(t, find));
  async function goTo(loc, opts = {}) {
    if (!loc || typeof loc !== 'object' || !Number.isInteger(loc.s)) loc = { s: 0, f: 0 };
    const t = { s: clamp(loc.s, 0, spine.length - 1), f: loc.f, a: loc.a, id: loc.id };
    const n = loc.n ?? (opts.query ? opts.query.length : 0);
    const find = n && loc.a != null ? { s: t.s, a: loc.a, n } : null;
    busy = false;
    await goToInternal(t, find);
  }
  const relayout = debounce(async () => {
    if (destroyed) return;
    const pos = lastPos ? { s: lastPos.s, a: lastPos.a } : { s: 0, a: 0 };
    applyVars();
    await build(pos);
  }, 180);

  /* ============================================================ INPUT ============================================================ */
  const hasSelection = () => { const s = getSelection(); return !!(s && !s.isCollapsed && root.contains(s.anchorNode)); };
  let ptr = null;
  const fwdSign = -nx;                                // dx sign that means "forward"

  function dragStart() {
    const u = units.cur; if (!u) return;
    pagesEl.style.transition = 'none'; u.body.style.transition = 'none';
    if (units.next) units.next.body.style.transition = 'none';
    if (units.prev) units.prev.body.style.transition = 'none';
  }
  function dragMove(dx) {
    const u = units.cur; if (!u) return;
    const forward = dx * fwdSign > 0;
    const edge = forward ? u.page >= u.pages - 1 : u.page <= 0;
    if (edge) {
      const has = forward ? units.next : units.prev;
      pagesEl.style.transform = `translate3d(${has ? dx : dx * 0.22}px,0,0)`;
      setPageTransform(u, u.page, false, 0);
    } else {
      pagesEl.style.transform = 'none';
      setPageTransform(u, u.page, false, dx);
    }
  }
  function dragEnd(dx, vx) {
    const u = units.cur; if (!u) return;
    const forward = dx * fwdSign > 0;
    const commit = Math.abs(dx) > geo.VW * 0.2 || (Math.abs(vx) > 0.45 && Math.abs(dx) > 24);
    if (!commit) { snapBack(); return; }
    const dir = forward ? 1 : -1;
    const k = u.page + dir;
    if (k >= 0 && k < u.pages) { u.page = k; setPageTransform(u, k, true); afterTurn(); pagesEl.style.transform = 'none'; api.interaction(); }
    else { pagesEl.style.transition = 'none'; turn(dir); }
  }

  view.addEventListener('pointerdown', (e) => {
    if (topSheet()) return; // settings / TOC / dialog open — never steal gestures
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), drag: false, moved: false, lx: e.clientX, lt: performance.now(), vx: 0, type: e.pointerType, target: e.target, sel: hasSelection() };
  });
  view.addEventListener('pointermove', (e) => {
    if (!ptr || e.pointerId !== ptr.id) return;
    if (topSheet()) { ptr = null; return; }
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
    if (!ptr.drag) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) ptr.moved = true;
      if (flowMode() === 'paged' && ptr.type !== 'mouse' && !busy && !ptr.sel && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.25 && !hasSelection()) {
        ptr.drag = true;
        try { view.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        getSelection()?.removeAllRanges();
        dragStart();
      }
    }
    if (ptr.drag) {
      const now = performance.now();
      if (now - ptr.lt > 8) { ptr.vx = (e.clientX - ptr.lx) / (now - ptr.lt); ptr.lx = e.clientX; ptr.lt = now; }
      dragMove(clamp(dx, -geo.VW, geo.VW));
    }
  });
  const endPtr = (e, cancelled) => {
    if (!ptr || e.pointerId !== ptr.id) return;
    const p = ptr; ptr = null;
    if (p.drag) { try { view.releasePointerCapture(e.pointerId); } catch { /* ignore */ } cancelled ? snapBack() : dragEnd(e.clientX - p.x, p.vx); return; }
    if (cancelled || p.moved) return;
    if (performance.now() - p.t > 520) return;                  // long press = text selection
    tap(e, p);
  };
  view.addEventListener('pointerup', (e) => endPtr(e, false));
  view.addEventListener('pointercancel', (e) => endPtr(e, true));

  function tap(e, p) {
    if (p.sel || hasSelection()) { getSelection()?.removeAllRanges(); return; }
    const el = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
    const a = el?.closest?.('a[data-href], a[data-ext]');
    if (a) { handleLink(a); return; }
    const mk = el?.closest?.('mark.hl');
    if (mk) { editHighlight(mk); return; }
    if (popEl) { closePop(); return; }
    const x = e.clientX - root.getBoundingClientRect().left;
    const R_ = R();
    if (flowMode() === 'paged' && R_.tapNav) {
      if (x < geo.VW * 0.28) { turn(nx > 0 ? -1 : 1); return; }
      if (x > geo.VW * 0.72) { turn(nx > 0 ? 1 : -1); return; }
    }
    api.toggleChrome();
  }

  const onKey = (e) => {
    if (destroyed || topSheet() || /input|textarea|select/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (flowMode() !== 'paged') return;
    const k = e.key;
    const fwd = k === 'PageDown' || (k === ' ' && !e.shiftKey) || k === (nx > 0 ? 'ArrowRight' : 'ArrowLeft');
    const back = k === 'PageUp' || (k === ' ' && e.shiftKey) || k === (nx > 0 ? 'ArrowLeft' : 'ArrowRight');
    if (fwd) { e.preventDefault(); turn(1); } else if (back) { e.preventDefault(); turn(-1); }
  };
  addEventListener('keydown', onKey);

  /* ---------- links, footnotes ---------- */
  let popEl = null, backChip = null, backT = 0;
  function closePop() { popEl?.remove(); popEl = null; }
  function showBack(loc) {
    backChip?.remove(); clearTimeout(backT);
    backChip = h('button', { class: 'ep-back', onclick: () => { backChip?.remove(); backChip = null; goTo(loc); } }, '↩ Back to where you were');
    root.append(backChip);
    backT = setTimeout(() => { backChip?.remove(); backChip = null; }, 9000);
  }
  async function showNote(a, s, frag) {
    const sec = await getSec(s);
    const hit = frag ? findById(sec, frag) : null;
    if (!hit?.el) return false;
    let blk = hit.el;
    if (!blk.textContent.trim()) blk = blk.parentElement || blk;
    blk = blk.closest('li,aside,dd,blockquote,p,div,section,td') || blk;
    if (blk.classList?.contains('ep-part') || blk.classList?.contains('ep-body')) return false;
    const text = blk.textContent.replace(/\s+/g, ' ').replace(/^[\s↩↑]+|[\s↩↑]+$/g, '').trim();
    if (!text || text.length > (a.dataset.note === '1' ? 2200 : 700)) return false;
    closePop();
    popEl = h('div', { class: 'ep-pop', role: 'dialog', 'aria-label': 'Note', style: { bottom: `${geo.sb + 62}px` } },
      h('button', { class: 'icon-btn x', 'aria-label': 'Close note', onclick: closePop }, '✕'),
      h('div', null, text),
      h('button', { class: 'link-btn', style: { marginTop: '10px' }, onclick: () => { closePop(); showBack(here().location); goTo({ s, f: 0, id: frag }); } }, 'Go to note'));
    root.append(popEl);
    return true;
  }
  async function handleLink(a) {
    api.interaction();
    if (a.dataset.ext) {
      if (await confirmDialog({ title: 'Open this link?', message: a.dataset.ext, confirmLabel: 'Open' })) window.open(a.dataset.ext, '_blank', 'noopener');
      return;
    }
    const s = hrefToS.get(a.dataset.href);
    if (s == null) { toast('That link points outside this book.'); return; }
    const frag = a.dataset.frag || '';
    if (a.dataset.note && await showNote(a, s, frag)) return;
    showBack(here().location);
    goTo({ s, f: 0, id: frag || undefined });
  }

  /* ---------- selection → highlights ---------- */
  let closeBar = null;
  const closestPart = (n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('.ep-part') || null;
  const onSel = debounce(() => {
    closeBar?.(); closeBar = null;
    const sel = getSelection();
    if (destroyed || !sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const sp = closestPart(range.startContainer), ep = closestPart(range.endContainer);
    const info = sp && partMap.get(sp);
    if (!info || !root.contains(sp)) return;
    const from = info.part.base + offsetIn(sp, range.startContainer, range.startOffset);
    const to = ep === sp ? info.part.base + offsetIn(sp, range.endContainer, range.endOffset) : info.part.base + info.part.chars;
    if (to <= from) return;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const save = async (color, note) => {
      const rec = await db.saveHighlight({ bookId: book.id, location: { s: info.sec.s, f: +(from / Math.max(1, info.sec.total)).toFixed(5), a: from, b: to }, text: text.slice(0, 600), color, note: note || '', label: chapterAt(info.sec.s, from)?.label || '' });
      hls.push(rec); renderMarks(info.sec, info.part);
      sel.removeAllRanges(); closeBar?.(); closeBar = null; api.interaction();
    };
    closeBar = showSelBar({
      host: root, rect: range.getBoundingClientRect(),
      onColor: (c) => save(c),
      onNote: async () => { const n = await promptDialog({ title: 'Add a note', label: 'Note', confirmLabel: 'Save' }); if (n != null) save('yellow', n.trim()); },
      onCopy: () => { navigator.clipboard?.writeText(text).then(() => toast('Copied')).catch(() => toast('Couldn’t copy')); sel.removeAllRanges(); closeBar?.(); closeBar = null; },
    });
  }, 240);
  document.addEventListener('selectionchange', onSel);

  function editHighlight(mk) {
    const rec = hls.find((x) => x.id === mk.dataset.id); if (!rec) return;
    closeBar?.();
    const redraw = () => rerenderAllMarks();
    closeBar = showSelBar({
      host: root, rect: mk.getBoundingClientRect(), current: rec.color,
      onColor: async (c) => { rec.color = c; await db.saveHighlight(rec); redraw(); closeBar?.(); closeBar = null; },
      onNote: async () => { const n = await promptDialog({ title: rec.note ? 'Edit note' : 'Add a note', label: 'Note', value: rec.note || '', confirmLabel: 'Save' }); if (n != null) { rec.note = n.trim(); await db.saveHighlight(rec); redraw(); } closeBar?.(); closeBar = null; },
      onCopy: () => { navigator.clipboard?.writeText(rec.text).then(() => toast('Copied')).catch(() => {}); closeBar?.(); closeBar = null; },
      onRemove: async () => { await db.deleteHighlight(rec.id); hls = hls.filter((x) => x !== rec); redraw(); closeBar?.(); closeBar = null; },
    });
  }

  /* ============================================================ CONTROLLER ============================================================ */
  const here = () => {
    const p = lastPos || { s: 0, a: 0, e: 0 };
    const sec = loadedSecs.get(p.s);
    return { location: { s: p.s, f: sec?.total ? +(p.a / sec.total).toFixed(5) : 0, a: p.a }, progress: (cum[p.s] + sizes[p.s] * (sec?.total ? Math.min(1, p.e / sec.total) : 0)) / TOTAL };
  };

  async function search(q, { signal, onHit }) {
    await tocP;
    return searchSpine(zip, spine, textCache, (s, a) => chapterAt(s, a)?.label, q, { signal, onHit });
  }

  function seekTarget(frac) {
    const at = clamp(frac, 0, 1) * TOTAL;
    let s = 0; for (let i = 0; i < cum.length; i++) if (cum[i] <= at) s = i;
    return { s, f: clamp((at - cum[s]) / sizes[s], 0, 0.999) };
  }

  const unsubs = [];
  unsubs.push(settings.on((k) => {
    if (k === 'reading' || k === 'app') { applyVars(); relayout(); return; }
    if (THEME_KEYS.has(k)) applyVars();
    else if (RELAYOUT_KEYS.has(k)) { applyVars(); relayout(); }
  }));
  const ro = new ResizeObserver(() => {
    const w = root.clientWidth, hh = root.clientHeight;
    if (!geo.VW || (Math.abs(w - geo.VW) < 2 && Math.abs(hh - geo.VH) < 2)) return;
    relayout();
  });
  ro.observe(root);

  /* ---------- settings panel — compact, visual, Apple Books–inspired ---------- */
  function buildSettingsPanel() {
    const fonts = [['serif', 'Serif'], ['sans', 'Sans'], ['humanist', 'Humanist'], ['mono', 'Mono']];
    const Sg = (k, v) => { settings.set('reading.' + k, v); setBookPref(k, v); };
    const fontGrid = h('div', { class: 'font-grid' }, fonts.map(([k, label]) => h('button', {
      class: 'font-btn' + (R().font === k ? ' on' : ''), style: { fontFamily: settings.FONT_STACKS[k] },
      onclick: (e) => { Sg('font', k); [...fontGrid.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); },
    }, label)));
    const themeItems = [{ value: 'auto', label: 'Auto', bg: 'linear-gradient(135deg,#f8f6f0 50%,#1e1e21 50%)', fg: '#888' }]
      .concat(Object.entries(settings.READING_THEMES).map(([value, t]) => ({ value, label: t.name, bg: t.bg, fg: t.fg })))
      .concat([{ value: 'custom', label: 'Custom', bg: R().customBg, fg: R().customFg }]);
    const picker = (label, key) => {
      const i = h('input', { type: 'color', class: 'color-input', value: R()[key], 'aria-label': label });
      i.addEventListener('input', () => { Sg(key, i.value); applyVars(); });
      return h('div', null, h('div', { class: 'field-label' }, label), i);
    };
    const custom = h('div', { style: { display: R().theme === 'custom' ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' } },
      picker('Background', 'customBg'), picker('Text', 'customFg'));
    const wrap = h('div', { class: 'rd-set-body' });
    const sizeSl = slider({ label: 'Text size', min: 12, max: 38, step: 1, value: R().size, format: (v) => v + ' px', onInput: (v) => Sg('size', v) });
    const sliders = {
      size: sizeSl,
      lineHeight: slider({ label: 'Line spacing', min: 1.2, max: 2.3, step: 0.05, value: R().lineHeight, format: (v) => v.toFixed(2), onInput: (v) => Sg('lineHeight', +v.toFixed(2)) }),
      letterSpacing: slider({ label: 'Letter spacing', min: 0, max: 0.14, step: 0.01, value: R().letterSpacing, format: (v) => v.toFixed(2) + ' em', onInput: (v) => Sg('letterSpacing', +v.toFixed(2)) }),
      wordSpacing: slider({ label: 'Word spacing', min: 0, max: 0.4, step: 0.02, value: R().wordSpacing || 0, format: (v) => v.toFixed(2) + ' em', onInput: (v) => Sg('wordSpacing', +v.toFixed(2)) }),
      firstLineIndent: slider({ label: 'First-line indent', min: 0, max: 3, step: 0.25, value: R().firstLineIndent || 0, format: (v) => v.toFixed(2) + ' em', onInput: (v) => Sg('firstLineIndent', +v.toFixed(2)) }),
      paraSpacing: slider({ label: 'Paragraph spacing', min: 0, max: 1.8, step: 0.1, value: R().paraSpacing, format: (v) => v.toFixed(1) + ' em', onInput: (v) => Sg('paraSpacing', +v.toFixed(1)) }),
      margin: slider({ label: 'Margins', min: 4, max: 80, step: 2, value: R().margin, format: (v) => v + ' px', onInput: (v) => Sg('margin', v) }),
      columnWidth: slider({ label: 'Text width', min: 360, max: 1000, step: 20, value: R().columnWidth, format: (v) => v + ' px', onInput: (v) => Sg('columnWidth', v) }),
    };
    const alignSeg = segmented([{ value: 'left', label: 'Left' }, { value: 'justify', label: 'Justified' }], R().align, (v) => Sg('align', v));
    const flowSeg = segmented([{ value: 'paged', label: 'Pages', icon: 'single' }, { value: 'scroll', label: 'Scroll', icon: 'scroll' }], R().flow, (v) => Sg('flow', v));
    const themeSw = swatches(themeItems, R().theme, (v) => { Sg('theme', v); custom.style.display = v === 'custom' ? 'grid' : 'none'; applyVars(); });
    wrap.append(
      // Primary controls first — what people change most
      group('Theme', themeSw, custom),
      group('Text', field('Font', fontGrid), sliders.size, field('Alignment', alignSeg)),
      group('Page', field('Reading style', flowSeg), sliders.margin, sliders.lineHeight),
      group('More',
        sliders.paraSpacing, sliders.letterSpacing, sliders.wordSpacing, sliders.firstLineIndent, sliders.columnWidth,
        toggleRow({ label: 'Dyslexia-friendly font', value: settings.get('app.dyslexia'), onChange: (v) => { settings.set('app.dyslexia', v); applyVars(); relayout(); } }),
        toggleRow({ label: 'Stop at chapter end', value: !!R().chapterStop, onChange: (v) => Sg('chapterStop', v) }),
        toggleRow({ label: 'Tap sides to turn page', value: R().tapNav !== false, onChange: (v) => Sg('tapNav', v) }),
        toggleRow({ label: 'Auto-hide controls', value: R().autoHide !== false, onChange: (v) => { Sg('autoHide', v); settings.set('reading.autoHide', v); } }),
        toggleRow({ label: 'Show time remaining', value: R().showTimeLeft !== false, onChange: (v) => { Sg('showTimeLeft', v); report(false); } })),
      h('button', { class: 'btn ghost', style: { marginTop: '14px' }, onclick: async () => {
        const d = settings.DEFAULTS.reading;
        for (const k of settings.BOOK_PREF_KEYS) { settings.set('reading.' + k, d[k]); }
        bookPrefs = null; book.readingPrefs = null;
        try { const { clearReadingPrefs } = await import('./ink-lib.js'); await clearReadingPrefs(book.id); } catch { /* ignore */ }
        applyVars(); relayout();
        Object.entries(sliders).forEach(([k, el]) => el.set?.(d[k] ?? 0));
        alignSeg.set(d.align); flowSeg.set?.(d.flow);
        [...fontGrid.children].forEach((b, i) => b.classList.toggle('on', fonts[i][0] === d.font));
      } }, 'Reset to defaults'));
    return wrap;
  }

  /* ---------- open at the saved place ---------- */
  const start = saved && typeof saved === 'object' && Number.isInteger(saved.s) ? { s: clamp(saved.s, 0, spine.length - 1), f: saved.f, a: saved.a } : { s: 0, f: 0 };
  const startFind = gotoQuery && start.a != null ? { s: start.s, a: start.a, n: gotoQuery.length } : null;
  await build(start, startFind);
  try { await tocP; report(false); } catch { /* ignore */ }

  return {
    kind: 'epub',
    toc: tocP,
    tocIndex: () => { const p = lastPos; return p ? chapterIndexAt(p.s, p.a) : null; },
    highlights: true,
    highlightsChanged: async () => { hls = await db.listHighlights(book.id); rerenderAllMarks(); },
    goTo,
    next: () => turn(1), prev: () => turn(-1),
    nextChapter: async () => {
      const p = lastPos; if (!p) return;
      const i = chapterIndexAt(p.s, p.a);
      const nxt = tocFlat[i + 1];
      if (nxt) goTo(nxt.location); else if (p.s + 1 < spine.length) goTo({ s: p.s + 1, f: 0 });
    },
    prevChapter: async () => {
      const p = lastPos; if (!p) return;
      const i = chapterIndexAt(p.s, p.a);
      const cur = tocFlat[i];
      if (cur && (cur.s < p.s || anchorChar(cur) < p.a - 400)) { goTo(cur.location); return; }
      const prv = tocFlat[i - 1];
      if (prv) goTo(prv.location); else if (p.s > 0) goTo({ s: p.s - 1, f: 0 }); else goTo({ s: 0, f: 0 });
    },
    seek: (f) => goTo(seekTarget(f)),
    seekLabel: (f) => { const t = seekTarget(f); const ch = chapterAt(t.s, 0); return `${ch?.label || 'Chapter ' + (t.s + 1)} · ${Math.round(clamp(f, 0, 1) * 100)}%`; },
    here,
    isVisible: (loc) => {
      if (!lastPos || !loc || loc.s !== lastPos.s) return false;
      const sec = loadedSecs.get(loc.s);
      const a = loc.a ?? Math.round((loc.f || 0) * (sec?.total || 0));
      return a >= lastPos.a && a <= lastPos.e;
    },
    bookmarkTitle: () => {
      const p = lastPos; if (!p) return 'Bookmark';
      const sec = loadedSecs.get(p.s);
      const part = sec && sec.parts[partIndexAt(sec, p.a)];
      const snip = part ? part.el.textContent.slice(p.a - part.base, p.a - part.base + 90).replace(/\s+/g, ' ').trim() : '';
      const ch = chapterAt(p.s, p.a)?.label;
      return [ch, snip ? '“' + snip.slice(0, 64) + (snip.length > 64 ? '…' : '') + '”' : ''].filter(Boolean).join(' — ') || 'Bookmark';
    },
    search,
    settingsPanel: buildSettingsPanel,
    chapterProgress,
    packageInfo: () => ({
      title: pkg.title || book.title,
      authors: pkg.authors?.length ? pkg.authors : (book.author ? [book.author] : []),
      publisher: pkg.publisher || book.meta?.publisher || '',
      pubDate: pkg.pubDate || book.meta?.pubDate || '',
      language: pkg.language || book.meta?.language || '',
      description: pkg.description || book.meta?.description || '',
      series: pkg.series || book.series || '',
      seriesIndex: pkg.seriesIndex ?? book.seriesNumber,
      chapters: tocFlat.length,
      spineItems: spine.length,
      version: pkg.version,
      rtl: rtlBook,
      size: book.size,
      format: 'EPUB',
    }),
    onChrome: () => {},
    destroy() {
      destroyed = true;
      removeEventListener('keydown', onKey);
      document.removeEventListener('selectionchange', onSel);
      unsubs.forEach((u) => u?.());
      ro.disconnect(); closeBar?.(); clearTimeout(settleT); clearTimeout(findT); clearTimeout(backT);
      for (const u of [units.prev, units.cur, units.next]) disposeUnit(u);
      for (const p of imgUrls.values()) p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
      host.replaceChildren();
    },
  };
}


/* ---------------- layout probing helpers ---------------- */
function textNodes(partEl) {
  const out = [];
  const tw = document.createTreeWalker(partEl, NodeFilter.SHOW_TEXT);
  let n, acc = 0;
  while ((n = tw.nextNode())) { const len = n.data.length; if (/\S/.test(n.data)) out.push({ n, start: acc }); acc += len; }
  return out;
}
const _rng = document.createRange();
function charRect(node, j) {
  try { _rng.setStart(node, j); _rng.setEnd(node, Math.min(node.data.length, j + 1)); } catch { return null; }
  const rs = _rng.getClientRects();
  return rs.length && (rs[0].width || rs[0].height) ? rs[0] : null;
}
/** offset of the first character whose box satisfies pred (pred must be false…false true…true in reading order) */
function firstCharWhere(partEl, pred, total) {
  const nodes = textNodes(partEl);
  if (!nodes.length) return 0;
  const first = (i) => Math.max(0, nodes[i].n.data.search(/\S/));
  const test = (i, j) => { const r = charRect(nodes[i].n, j); return r ? pred(r) : false; };
  let lo = 0, hi = nodes.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (!test(mid, first(mid))) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  if (idx < 0) return nodes[0].start + first(0);
  const data = nodes[idx].n.data, len = data.length;
  let a = first(idx), b = len;
  while (a < b) {
    const mid = (a + b) >> 1;
    let p = mid; while (p < len && !/\S/.test(data[p])) p++;
    if (p >= len) { b = mid; continue; }
    if (test(idx, p)) b = mid; else a = mid + 1;
  }
  if (a < len) return nodes[idx].start + a;
  return idx + 1 < nodes.length ? nodes[idx + 1].start + first(idx + 1) : total;
}

/* ---------------- search (shared with library-wide search) ---------------- */
async function searchSpine(zip, spine, cache, labelAt, q, { signal, onHit }) {
  const needle = q.toLowerCase();
  for (let s = 0; s < spine.length; s++) {
    if (signal?.aborted) return;
    let sx; try { sx = await sectionText(zip, spine[s], s, cache); } catch { continue; }
    const text = sx.text, low = text.toLowerCase();
    let from = 0, n = 0;
    while (n < 6) {
      const k = low.indexOf(needle, from); if (k < 0) break;
      from = k + needle.length; n++;
      const a = Math.max(0, k - 48), b = Math.min(text.length, k + needle.length + 72);
      const snippet = (a > 0 ? '…' : '') + snippetOf(sx, a, b) + (b < text.length ? '…' : '');
      if (onHit({ label: labelAt?.(s, k) || `Section ${s + 1}`, snippet, location: { s, f: +(k / Math.max(1, text.length)).toFixed(5), a: k, n: needle.length } }) === false) return;
    }
    if (s % 4 === 3) await sleep(0);
  }
}
export async function searchBlob(blob, query, { signal, onHit }) {
  const zip = await openZip(blob);
  const pkg = await loadEpubPackage(zip);
  const spine = pkg.spine.filter((it) => zip.has(it.href));
  const hrefToS = new Map(spine.map((it, i) => [it.href, i]));
  const toc = await loadEpubToc(zip, pkg).catch(() => []);
  const marks = toc.map((t) => ({ s: hrefToS.get(String(t.href || '').split('#')[0]), label: t.label })).filter((t) => t.s != null);
  const labelAt = (s) => { let best = null; for (const m of marks) if (m.s <= s && (!best || m.s >= best.s)) best = m; return best?.label; };
  return searchSpine(zip, spine, new Map(), labelAt, query, { signal, onHit });
}
