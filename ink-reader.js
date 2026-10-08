/* INK — reader shell shared by every format.
 *
 * Engines (ink-engine-epub / pdf / comic) draw the pages; this file owns the chrome:
 * top bar, progress bar, contents / bookmarks / highlights / search / settings / thumbnails panels,
 * auto-hide, progress saving, reading statistics and the friendly error screen.
 *
 * An engine module exports  open({ book, blob, host, api, saved }) → controller
 *   controller = {
 *     toc: [{label, location, depth}] | Promise<…>,
 *     goTo(location, {query}), next(), prev(), nextChapter?(), prevChapter?(),
 *     seek(frac), seekLabel?(frac), here() → {location, progress, label, sub},
 *     isVisible(location) → bool, bookmarkTitle() → string,
 *     search?(q, {signal, onHit}), settingsPanel(api) → Element,
 *     thumbs?: { count, render(i) → Promise<Blob>, current() → i },
 *     highlights?: true, destroy()
 *   }
 * api (given to the engine) = { relocate(info), toggleChrome(), hideChrome(), showChrome(), interaction(),
 *                               toast(msg), chromeVisible(), refreshMarks(), askPassword(), uiDirection }
 */
import { h, icon, debounce, pct, $, clamp } from './ink-util.js';
import * as db from './ink-db.js';
import * as lib from './ink-lib.js';
import * as settings from './ink-settings.js';
import * as stats from './ink-stats.js';
import { openSheet, toast, errorView, segmented, promptDialog, confirmDialog, closeAllSheets, topSheet } from './ink-ui.js';

const LOADERS = {
  epub: () => import('./ink-engine-epub.js'),
  pdf: () => import('./ink-engine-pdf.js'),
  comic: () => import('./ink-engine-comic.js'),
};

export async function mountReader(root, book, { exit }) {
  let ctl = null, destroyed = false, chromeOn = true, hideT = 0, lastInfo = null, lastLoc = null;
  const unsubs = [];

  /* ---------- DOM ---------- */
  const stage = h('div', { class: 'rd-stage', tabindex: '-1' });
  const titleEl = h('div', { class: 'rd-title' }, h('span', null, book.title));
  const btn = (name, label, onclick, extra = '') => h('button', { class: 'icon-btn rd-btn ' + extra, 'aria-label': label, title: label, onclick }, icon(name, 22));
  const bmBtn = btn('bookmark', 'Bookmark this page', () => toggleBookmark(), 'rd-bm');
  const searchBtn = btn('search', 'Search in book', () => openSearch());
  const tocBtn = btn('toc', 'Contents', () => openContents());
  const setBtn = btn('type', 'Reading settings', () => openSettings());
  const backBtn = btn('back', 'Back to library', () => exit());
  const top = h('header', { class: 'rd-top' }, backBtn, titleEl, h('div', { class: 'rd-actions' }, searchBtn, bmBtn, tocBtn, setBtn));

  const labelEl = h('span', { class: 'rd-label' });
  const subEl = h('span', { class: 'rd-sub' });
  const range = h('input', { type: 'range', class: 'rd-range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Position in book' });
  const prevCh = h('button', { class: 'icon-btn rd-btn small', 'aria-label': 'Previous chapter', onclick: () => { api.interaction(); ctl?.prevChapter?.(); } }, icon('chevL', 20));
  const nextCh = h('button', { class: 'icon-btn rd-btn small', 'aria-label': 'Next chapter', onclick: () => { api.interaction(); ctl?.nextChapter?.(); } }, icon('chevR', 20));
  const bottom = h('footer', { class: 'rd-bottom' },
    h('div', { class: 'rd-info' }, labelEl, subEl),
    h('div', { class: 'rd-seek' }, prevCh, range, nextCh));
  const loading = h('div', { class: 'rd-loading', role: 'status' }, h('div', { class: 'rd-spin' }), h('div', { class: 'rd-load-t' }, 'Opening…'));
  const rd = h('div', { class: 'rd chrome-on', 'data-format': book.format }, stage, top, bottom, loading);
  root.replaceChildren(rd);

  /* ---------- chrome visibility ---------- */
  const setChrome = (on) => {
    if (chromeOn === on) return;
    chromeOn = on;
    rd.classList.toggle('chrome-on', on);
    ctl?.onChrome?.(on);
    schedule();
  };
  const schedule = () => {
    clearTimeout(hideT);
    if (chromeOn && settings.get('reading.autoHide')) {
      hideT = setTimeout(() => { if (!topSheet() && !dragging) setChrome(false); }, 4200);
    }
  };
  let dragging = false;

  /* ---------- API for engines ---------- */
  const saveSoon = debounce(() => save(), 700);
  function save() {
    if (!lastInfo || !lastInfo.location) return;
    lib.saveProgress(book.id, { location: lastInfo.location, progress: clamp(lastInfo.progress || 0, 0, 1), label: lastInfo.label || '' });
  }
  const api = {
    uiDirection: document.dir || 'ltr',
    relocate(info) {
      lastInfo = info;
      if (info.turned && JSON.stringify(info.location) !== JSON.stringify(lastLoc)) stats.pages(1);
      lastLoc = info.location;
      labelEl.textContent = info.label || '';
      subEl.textContent = info.sub || '';
      if (!dragging) range.value = Math.round(clamp(info.progress || 0, 0, 1) * 1000);
      range.setAttribute('aria-valuetext', info.label || '');
      refreshMarks();
      saveSoon();
    },
    toggleChrome() { setChrome(!chromeOn); },
    hideChrome() { setChrome(false); },
    showChrome() { setChrome(true); schedule(); },
    chromeVisible: () => chromeOn,
    interaction() { stats.interaction(); if (chromeOn) schedule(); },
    toast,
    refreshMarks,
    saveNow: save,
    setLoading(on, text) { loading.classList.toggle('on', on); if (text) loading.querySelector('.rd-load-t').textContent = text; },
    async askPassword(retry) {
      return promptDialog({ title: retry ? 'Wrong password' : 'This file is password protected', label: 'Password', type: 'password', confirmLabel: 'Open' });
    },
    book,
  };

  /* ---------- seek bar ---------- */
  range.addEventListener('pointerdown', () => { dragging = true; clearTimeout(hideT); });
  range.addEventListener('input', () => {
    stats.interaction();
    const f = range.value / 1000;
    const l = ctl?.seekLabel?.(f);
    if (l) labelEl.textContent = l;
  });
  const commit = () => { if (!dragging) return; dragging = false; ctl?.seek?.(range.value / 1000); schedule(); };
  range.addEventListener('change', commit);
  range.addEventListener('pointerup', () => setTimeout(commit, 0));
  range.addEventListener('keydown', () => { dragging = true; });
  range.addEventListener('keyup', () => setTimeout(commit, 0));

  /* ---------- bookmarks ---------- */
  let marks = [];
  async function loadMarks() { marks = await db.listBookmarks(book.id); refreshMarks(); }
  function currentMark() { return ctl && marks.find((m) => { try { return ctl.isVisible(m.location); } catch { return false; } }); }
  function refreshMarks() {
    const on = !!currentMark();
    bmBtn.classList.toggle('on', on);
    bmBtn.replaceChildren(icon(on ? 'bookmarkOn' : 'bookmark', 22));
    bmBtn.setAttribute('aria-pressed', on);
    bmBtn.setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark this page');
  }
  async function toggleBookmark() {
    if (!ctl || !lastInfo) return;
    api.interaction();
    const m = currentMark();
    if (m) { await db.deleteBookmark(m.id); marks = marks.filter((x) => x !== m); toast('Bookmark removed'); }
    else { const b = await db.addBookmark(book.id, lastInfo.location, ctl.bookmarkTitle?.() || lastInfo.label || 'Bookmark'); marks.push(b); toast('Bookmarked'); }
    refreshMarks();
  }

  /* ---------- panels ---------- */
  function openContents(start) {
    api.interaction();
    const hasHl = !!ctl?.highlights;
    const hasThumbs = !!ctl?.thumbs;
    const tabs = [{ value: 'toc', label: book.format === 'comic' ? 'Pages' : 'Contents' }, { value: 'marks', label: 'Bookmarks' }];
    if (hasHl) tabs.push({ value: 'hl', label: 'Highlights' });
    if (hasThumbs && book.format !== 'comic') tabs.splice(1, 0, { value: 'thumbs', label: 'Pages' });
    const view = h('div', { class: 'panel-view' });
    let tab = start || (book.format === 'comic' ? 'thumbs' : 'toc');
    if (book.format === 'comic') { tabs[0] = { value: 'thumbs', label: 'Pages' }; if (ctl.toc?.length) tabs.splice(1, 0, { value: 'toc', label: 'Chapters' }); }
    const seg = segmented(tabs, tab, (v) => { tab = v; draw(); }, { label: 'Panel' });
    let sheet;
    const draw = () => {
      view.replaceChildren();
      if (tab === 'toc') drawToc(view, () => sheet.close());
      else if (tab === 'marks') drawMarks(view, () => sheet.close());
      else if (tab === 'hl') drawHighlights(view, () => sheet.close());
      else drawThumbs(view, () => sheet.close());
    };
    sheet = openSheet({ title: book.title, size: 'l', className: 'panel', body: () => { draw(); return h('div', null, h('div', { class: 'panel-tabs' }, seg), view); } });
  }

  async function drawToc(view, close) {
    const toc = await ctl.toc;
    if (!toc || !toc.length) { view.append(h('div', { class: 'hint-card' }, 'This book has no table of contents.')); return; }
    const list = h('div', { class: 'toc' });
    let here = null;
    for (const t of toc) {
      const b = h('button', { class: 'toc-item d' + Math.min(t.depth || 0, 3), onclick: () => { close(); ctl.goTo(t.location); } }, h('span', null, t.label));
      b._t = t;
      list.append(b);
    }
    view.append(list);
    try { const idx = ctl.tocIndex?.(); if (idx != null && list.children[idx]) { here = list.children[idx]; here.classList.add('here'); here.scrollIntoView({ block: 'center' }); } } catch { /* ignore */ }
  }
  async function drawMarks(view, close) {
    marks = await db.listBookmarks(book.id);
    if (!marks.length) { view.append(h('div', { class: 'hint-card' }, 'No bookmarks yet. Tap the bookmark icon while reading.')); return; }
    const list = h('div', { class: 'list' });
    for (const m of marks) {
      list.append(h('div', { class: 'note-row' },
        h('button', { class: 'note-main', onclick: () => { close(); ctl.goTo(m.location); } }, h('div', { class: 'note-title' }, m.title || 'Bookmark'), h('div', { class: 'note-sub' }, new Date(m.createdAt).toLocaleDateString())),
        h('button', { class: 'icon-btn', 'aria-label': 'Delete bookmark', onclick: async () => { await db.deleteBookmark(m.id); marks = marks.filter((x) => x.id !== m.id); refreshMarks(); drawMarks(view.replaceChildren() || view, close); } }, icon('trash', 18))));
    }
    view.append(list);
  }
  async function drawHighlights(view, close) {
    const hs = await db.listHighlights(book.id);
    if (!hs.length) { view.append(h('div', { class: 'hint-card' }, 'Select text while reading to highlight it.')); return; }
    const list = h('div', { class: 'list' });
    for (const x of hs) {
      list.append(h('div', { class: 'note-row' },
        h('button', { class: 'note-main', onclick: () => { close(); ctl.goTo(x.location); } },
          h('div', { class: 'note-quote', style: { '--hl': hlColor(x.color) } }, x.text),
          x.note ? h('div', { class: 'note-text' }, x.note) : null,
          h('div', { class: 'note-sub' }, [x.label, new Date(x.createdAt).toLocaleDateString()].filter(Boolean).join(' · '))),
        h('button', { class: 'icon-btn', 'aria-label': 'Delete highlight', onclick: async () => { await db.deleteHighlight(x.id); ctl.highlightsChanged?.(); drawHighlights(view.replaceChildren() || view, close); } }, icon('trash', 18))));
    }
    view.append(list);
  }
  function drawThumbs(view, close) {
    const T = ctl.thumbs;
    const grid = h('div', { class: 'thumbs' });
    const cur = T.current();
    const cells = [];
    const queue = []; let running = 0;
    const pump = () => {
      while (running < 2 && queue.length) {
        const c = queue.shift(); running++;
        T.render(c.i).then((blob) => { if (blob && c.img.isConnected) { c.img.src = URL.createObjectURL(blob); c.img.onload = () => { URL.revokeObjectURL(c.img.src); c.el.classList.add('ready'); }; } })
          .catch(() => {}).finally(() => { running--; pump(); });
      }
    };
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); queue.push(e.target._c); } pump(); }, { root: view.closest('.sheet-body'), rootMargin: '400px' });
    for (let i = 0; i < T.count; i++) {
      const img = h('img', { alt: '', decoding: 'async' });
      const el = h('button', { class: 'thumb' + (i === cur ? ' here' : ''), 'aria-label': 'Page ' + (i + 1), onclick: () => { close(); ctl.goTo(T.location ? T.location(i) : i); } }, h('div', { class: 'thumb-img', style: { aspectRatio: T.aspect || '2/3' } }, img), h('span', null, i + 1));
      el._c = { i, img, el };
      cells.push(el); grid.append(el);
    }
    view.append(grid);
    requestAnimationFrame(() => { cells.forEach((c) => io.observe(c)); cells[cur]?.scrollIntoView({ block: 'center' }); });
  }

  function openSearch() {
    if (!ctl?.search) { toast('Search isn’t available for this file'); return; }
    api.interaction();
    let abort = null;
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Search in this book', 'aria-label': 'Search in this book', enterkeyhint: 'search', autocomplete: 'off' });
    const status = h('div', { class: 'row-hint', style: { margin: '10px 0' } });
    const results = h('div', { class: 'list' });
    let sheet;
    const run = async () => {
      abort?.abort();
      const q = input.value.trim();
      results.replaceChildren(); status.textContent = '';
      if (q.length < 2) return;
      const ac = abort = new AbortController();
      status.textContent = 'Searching…';
      let n = 0;
      try {
        await ctl.search(q, { signal: ac.signal, onHit: (hit) => {
          if (ac.signal.aborted) return false;
          n++;
          results.append(h('button', { class: 'result', onclick: () => { sheet.close(); ctl.goTo(hit.location, { query: q }); } },
            h('div', { class: 'li-text' }, h('div', { class: 'li-sub' }, hit.label), h('div', { class: 'result-snippet' }, snippet(hit.snippet, q)))));
          if (n >= 200) return false;
          status.textContent = n + (n === 1 ? ' result' : ' results') + '…';
          return true;
        } });
        if (!ac.signal.aborted) status.textContent = n ? `${n} result${n === 1 ? '' : 's'}` : (book.meta?.scanned ? 'This looks like a scanned book — INK can’t read the text inside images.' : 'No matches.');
      } catch (e) { if (!ac.signal.aborted) status.textContent = 'Search failed.'; }
    };
    input.addEventListener('input', debounce(run, 250));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); run(); } });
    sheet = openSheet({ title: 'Search', size: 'l', className: 'panel', onClose: () => abort?.abort(), body: () => h('div', null, h('div', { class: 'search-box' }, icon('search', 20), input), status, results) });
  }

  function openSettings() {
    if (!ctl?.settingsPanel) return;
    api.interaction();
    openSheet({ title: book.format === 'epub' ? 'Reading settings' : book.format === 'pdf' ? 'PDF settings' : 'Comic settings', size: 'l', className: 'panel rd-settings', body: (s) => ctl.settingsPanel(api, s) });
  }

  /* ---------- keyboard ---------- */
  const onKey = (e) => {
    if (topSheet() || /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === 'Escape') { if (chromeOn && settings.get('reading.autoHide')) setChrome(false); else exit(); return; }
    if (e.key === 't') openContents();
    else if (e.key === '/' || (e.key === 'f' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); openSearch(); }
    else if (e.key === 'b') toggleBookmark();
    else if (e.key === 'm') api.toggleChrome();
  };
  addEventListener('keydown', onKey);
  unsubs.push(() => removeEventListener('keydown', onKey));
  unsubs.push(settings.on((k) => { if (k === 'reading.autoHide') schedule(); }));
  const onVis = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', onVis); addEventListener('pagehide', save);
  unsubs.push(() => { document.removeEventListener('visibilitychange', onVis); removeEventListener('pagehide', save); });

  /* ---------- open the book ---------- */
  const fail = (title, reason, extra = []) => {
    loading.classList.remove('on');
    rd.classList.add('chrome-on', 'failed');
    stage.replaceChildren(errorView({ title, reason, actions: [...extra, { label: 'Back to library', kind: 'primary', onClick: exit }] }));
  };

  let blob = null;
  try { blob = await db.getFile(book.id); } catch { /* handled below */ }
  if (destroyed) return () => {};
  if (!blob) {
    fail("INK couldn't open this file.", 'The file is missing from INK’s storage. You can remove it from your library and import it again.', [{
      label: 'Remove from library', onClick: async () => { if (await confirmDialog({ title: 'Remove this book?', message: 'Its reading progress will be deleted too.', confirmLabel: 'Remove', danger: true })) { await lib.removeBook(book.id); exit(); } } }]);
  } else {
    loading.classList.add('on');
    try {
      const mod = await LOADERS[book.format]();
      const goto = takeGoto(book.id);
      ctl = await mod.open({ book, blob, host: stage, api, saved: goto?.location ?? book.currentLocation, gotoQuery: goto?.q });
      if (destroyed) { ctl?.destroy?.(); return () => {}; }
      loading.classList.remove('on');
      searchBtn.hidden = !ctl.search;
      tocBtn.querySelector('svg')?.setAttribute('aria-hidden', 'true');
      stats.begin(book.id);
      lib.touchOpened(book.id);
      await loadMarks();
      Promise.resolve(ctl.toc).then((t) => { if (t && !t.length && !ctl.thumbs && !ctl.highlights) tocBtn.hidden = false; }).catch(() => {});
      schedule();
    } catch (e) {
      if (e?.cancelled) { exit(); return () => {}; }
      console.error('open failed', e);
      const m = String(e?.message || e || '');
      const reason = e?.code === 'rar-addon' || e?.code === 'unsupported' ? m : /password/i.test(m) ? 'This file is password protected.' : /quota/i.test(m) ? 'Not enough free memory to open this file.' : 'The file may be damaged or incomplete. Try importing it again.';
      fail("INK couldn't open this file.", reason);
    }
  }

  return async function destroy() {
    destroyed = true;
    clearTimeout(hideT);
    try { save(); } catch { /* ignore */ }
    unsubs.forEach((u) => { try { u?.(); } catch { /* ignore */ } });
    try { await ctl?.destroy?.(); } catch (e) { console.warn(e); }
    await stats.end();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  };
}

/* ---------- helpers ---------- */
function takeGoto(id) {
  try {
    const g = JSON.parse(sessionStorage.getItem('ink-goto') || 'null');
    sessionStorage.removeItem('ink-goto');
    return g && g.id === id ? g : null;
  } catch { return null; }
}
export const HL_COLORS = { yellow: '#f2d45c', green: '#7bd08a', blue: '#6db5f0', pink: '#f08fb4', orange: '#f2a45c' };
export const hlColor = (c) => HL_COLORS[c] || HL_COLORS.yellow;
function snippet(text, q) {
  const frag = document.createDocumentFragment();
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  String(text).split(re).forEach((p, i) => frag.append(i % 2 ? h('mark', null, p) : p));
  return frag;
}
