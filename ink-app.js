/* INK — application shell: boot, router, import UI, drag & drop, PWA hooks */
import { $, h, icon } from './ink-util.js';
import * as settings from './ink-settings.js';
import * as db from './ink-db.js';
import * as lib from './ink-lib.js';
import { importFiles, filesFromFolder, migrateLegacy, ACCEPT, EXT_RE } from './ink-import.js';
import { toast, actionSheet, closeAllSheets } from './ink-ui.js';
import { bus } from './ink-util.js';
import { renderHome } from './ink-home.js';
import { renderBrowse, renderSeries } from './ink-browse.js';
import { renderSearch } from './ink-search.js';
import { renderSettings } from './ink-settings-ui.js';
import { showOnboarding } from './ink-onboard.js';

const viewEl = $('#view');
const appEl = $('#app');
const readerRoot = $('#reader-root');

/* ---------------- import UI ---------------- */
const fileInput = h('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true });
const folderInput = h('input', { type: 'file', multiple: true, hidden: true });
folderInput.setAttribute('webkitdirectory', '');
document.body.append(fileInput, folderInput);

let pill = null;
let busy = false;
const queue = [];

function showPill(state) {
  if (!pill) {
    pill = h('div', { class: 'import-pill', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 't' }), h('div', { class: 's' }), h('div', { class: 'bar' }, h('i')));
    $('#overlay-root').append(pill);
  }
  pill.querySelector('.t').textContent = state.name;
  pill.querySelector('.s').textContent = state.sub;
  pill.querySelector('i').style.width = state.pct + '%';
}
function hidePill() { pill?.remove(); pill = null; }

export async function runImport(files) {
  files = [...files];
  if (!files.length) return;
  queue.push(...files);
  if (busy) return;
  busy = true;
  const total = { added: 0, duplicate: 0, failed: [] };
  while (queue.length) {
    const batch = queue.splice(0, queue.length);
    const res = await importFiles(batch, (s) => {
      showPill({ name: s.name, sub: `Importing ${s.i + 1} of ${s.n}…`, pct: Math.round(((s.i + (s.phase === 'done' ? 1 : 0.3)) / s.n) * 100) });
    });
    total.added += res.added.length; total.duplicate += res.duplicate.length; total.failed.push(...res.failed);
  }
  busy = false;
  hidePill();
  await lib.load();
  summarize(total);
}

function summarize(t) {
  if (t.failed.length) {
    const f = t.failed[0];
    const msg = t.failed.length === 1 ? `INK couldn’t open “${f.name}”. ${f.error}` : `${t.added} added · ${t.failed.length} couldn’t be imported`;
    toast(msg, { ms: 6500, action: t.failed.length > 1 ? { label: 'Details', fn: () => showFailures(t.failed) } : null });
  } else if (t.added) {
    toast(t.added === 1 ? 'Added to your library' : `${t.added} books added` + (t.duplicate ? ` · ${t.duplicate} already here` : ''));
  } else if (t.duplicate) toast(t.duplicate === 1 ? 'That book is already in your library' : 'Those books are already in your library');
}

async function showFailures(list) {
  const { openSheet } = await import('./ink-ui.js');
  openSheet({ title: 'Couldn’t import', size: 'm', body: () => h('div', null, list.map((f) => h('div', { class: 'row' }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, f.name), h('span', { class: 'row-hint' }, f.error))))) });
}

fileInput.addEventListener('change', () => { const f = [...fileInput.files]; fileInput.value = ''; runImport(f); });
folderInput.addEventListener('change', () => {
  const f = filesFromFolder(folderInput.files); folderInput.value = '';
  if (!f.length) toast('No EPUB, PDF, CBZ or CBR files found in that folder'); else runImport(f);
});

const pickFiles = () => fileInput.click();
const pickFolder = () => folderInput.click();
const importMenu = () => actionSheet('Import', [
  { label: 'Choose files…', icon: 'plus', onClick: pickFiles },
  { label: 'Import a folder…', icon: 'folder', onClick: pickFolder },
]);

/* ---------------- covers ---------------- */
async function buildCover(book) {
  const blob = await db.getFile(book.id);
  if (!blob) return null;
  const { thumbFromBlob, epubCover, pdfCover, typographicCover } = await import('./ink-covers.js');
  let cover = null;
  try {
    if (book.format === 'epub') {
      const { openZip } = await import('./ink-zip.js');
      cover = await epubCover(await openZip(blob));
    } else if (book.format === 'pdf') {
      const { openPdf } = await import('./ink-pdfjs.js');
      const pdf = await openPdf(blob);
      try { cover = await pdfCover(pdf); } finally { try { await pdf.destroy(); } catch { /* ignore */ } }
    } else {
      const { openComicSource } = await import('./ink-comic-src.js');
      const src = await openComicSource(blob);
      try { cover = await thumbFromBlob(await src.getBlob(0)); } finally { src.close(); }
    }
  } catch { /* fall through to typographic */ }
  return cover || typographicCover(book.title, book.author, book.format === 'comic' ? book.ext : book.format);
}
async function rebuildCovers() {
  for (const b of lib.books()) {
    try {
      const c = await buildCover(b);
      if (c) { await db.putCover(b.id, c); await db.patchBook(b.id, { hasCover: true }, { silent: true }); lib.refreshCover(b.id); }
    } catch (e) { console.warn('cover failed', b.title, e); }
  }
  await lib.load();
}
async function backfillCovers() {
  for (const b of lib.books()) {
    if (b.hasCover) continue;
    try {
      const c = await buildCover(b);
      if (c) { await db.putCover(b.id, c); await db.patchBook(b.id, { hasCover: true }, { silent: true }); lib.refreshCover(b.id); }
    } catch { /* skip */ }
  }
}

const ctx = { importMenu, pickFiles, pickFolder, rebuildCovers, runImport };

/* ---------------- router ---------------- */
const TABS = [['#/', 'Library', 'library'], ['#/search', 'Search', 'search'], ['#/settings', 'Settings', 'settings']];
const scrollMemo = new Map();
let cleanup = null;
let current = '';
let readerHandle = null;

function parse() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, params: new URLSearchParams(qs), parts: path.split('/').filter(Boolean) };
}
function tabFor(parts) {
  if (parts[0] === 'search') return '#/search';
  if (parts[0] === 'settings') return '#/settings';
  return '#/';
}

function setNav(active) {
  document.querySelectorAll('[data-tab]').forEach((el) => { if (el.dataset.tab === active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  requestAnimationFrame(() => moveTabGlow());
  document.querySelectorAll('[data-side]').forEach((el) => { el.removeAttribute('aria-current'); if (el.dataset.side === (location.hash || '#/')) el.setAttribute('aria-current', 'page'); });
}

async function route() {
  closeAllSheets();
  const { parts, params } = parse();
  if (parts[0] === 'read' && parts[1]) return openReader(parts[1]);
  if (readerHandle) await closeReader();

  scrollMemo.set(current, viewEl.scrollTop);
  cleanup?.(); cleanup = null;
  current = location.hash || '#/';
  appEl.hidden = false;
  document.body.classList.remove('reading');

  const head = parts[0] || '';
  let out;
  if (head === '') out = renderHome(viewEl, ctx);
  else if (head === 'browse') out = renderBrowse(viewEl, ctx, params);
  else if (head === 'series') out = renderSeries(viewEl, ctx, decodeURIComponent(parts[1] || ''));
  else if (head === 'search') out = renderSearch(viewEl, ctx, params);
  else if (head === 'settings') out = renderSettings(viewEl, ctx);
  else { location.replace('#/'); return; }
  if (typeof out === 'function') cleanup = out;
  setNav(tabFor(parts));
  viewEl.scrollTop = scrollMemo.get(current) || 0;
  renderSide();
}

async function openReader(id) {
  const book = lib.byId(id);
  if (!book) { toast('That book is no longer in your library'); location.replace('#/'); return; }
  if (readerHandle?.id === id) return;
  if (readerHandle) await closeReader();
  scrollMemo.set(current, viewEl.scrollTop);
  document.body.classList.add('reading');
  appEl.hidden = true;
  readerRoot.hidden = false;
  try {
    const mod = await import('./ink-reader.js');
    readerHandle = { id, destroy: null };
    const handle = readerHandle;
    handle.destroy = await mod.mountReader(readerRoot, book, {
      exit: () => { if (history.length > 1) history.back(); else location.replace('#/'); },
    });
    if (readerHandle !== handle) handle.destroy?.();
  } catch (e) {
    console.error(e);
    readerHandle = null;
    readerRoot.hidden = true; appEl.hidden = false; document.body.classList.remove('reading');
    toast('INK couldn’t open this file.');
    location.replace('#/');
  }
}
async function closeReader() {
  const hd = readerHandle; readerHandle = null;
  try { await hd?.destroy?.(); } catch (e) { console.warn(e); }
  readerRoot.replaceChildren(); readerRoot.hidden = true;
  document.body.classList.remove('reading');
  appEl.hidden = false;
  await lib.load();
}

/* ---------------- sidebar + tab bar ---------------- */
function buildNav() {
  const tabbar = $('#tabbar');
  tabbar.append(h('i', { class: 'tab-glow', 'aria-hidden': 'true' }), ...TABS.map(([href, label, ic]) => h('a', { class: 'tab', href, 'data-tab': href }, icon(ic, 24), h('span', null, label))));
  $('#sidebar').replaceChildren(h('div', { class: 'wordmark' }, 'INK'),
    ...TABS.map(([href, label, ic]) => h('a', { class: 'side-link', href, 'data-side': href, 'data-tab': href }, icon(ic, 20), label)),
    h('div', { id: 'side-lib' }),
    h('button', { class: 'side-link', style: { marginTop: 'auto' }, onclick: importMenu }, icon('plus', 20), 'Import'));
}
export function moveTabGlow() {
  const bar = document.getElementById('tabbar'), glow = bar?.querySelector('.tab-glow'), cur = bar?.querySelector('.tab[aria-current="page"]');
  if (!glow) return;
  if (!cur || !bar.offsetWidth) { glow.style.opacity = '0'; return; }
  glow.style.width = cur.offsetWidth + 'px';
  glow.style.transform = `translateX(${cur.offsetLeft}px)`;
  if (!glow.dataset.init) { glow.style.transition = 'none'; void glow.offsetWidth; }
  glow.style.opacity = '1';
  if (!glow.dataset.init) { glow.dataset.init = '1'; requestAnimationFrame(() => { glow.style.transition = ''; }); }
}
addEventListener('resize', () => moveTabGlow());
function renderSide() {
  const el = $('#side-lib'); if (!el) return;
  const all = lib.books();
  const n = (f) => all.filter((b) => b.format === f).length;
  const link = (href, label, ic, count) => h('a', { class: 'side-link', href, 'data-side': href }, icon(ic, 20), label, count != null ? h('span', { class: 'count' }, count) : null);
  el.replaceChildren(
    h('div', { class: 'side-h' }, 'Browse'),
    link('#/browse?f=epub', 'Books', 'book', n('epub')), link('#/browse?f=comic', 'Comics', 'comic', n('comic')), link('#/browse?f=pdf', 'PDFs', 'pdf', n('pdf')),
    link('#/browse?s=favorites', 'Favorites', 'heart'),
    lib.collections().length ? h('div', { class: 'side-h' }, 'Collections') : null,
    ...lib.collections().map((c) => link('#/browse?c=' + c.id, c.name, 'collection')));
  document.querySelectorAll('[data-side]').forEach((a) => { if (a.dataset.side === (location.hash || '#/')) a.setAttribute('aria-current', 'page'); });
}

/* ---------------- drag & drop ---------------- */
function setupDrop() {
  const dz = h('div', { class: 'dropzone' }, h('div', null, 'Drop to import', h('small', null, 'EPUB · PDF · CBR · CBZ')));
  $('#overlay-root').append(dz);
  let depth = 0;
  addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; dz.classList.add('on'); } });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('on'); });
  addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); depth = 0; dz.classList.remove('on');
    runImport([...e.dataTransfer.files].filter((f) => EXT_RE.test(f.name) || !f.type || /epub|pdf|zip|comic|rar/i.test(f.type)));
  });
}

/* ---------------- PWA: file handling, share target, service worker ---------------- */
function setupPwa() {
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (p) => {
      if (!p.files?.length) return;
      const files = [];
      for (const hnd of p.files) { try { files.push(await hnd.getFile()); } catch { /* ignore */ } }
      if (files.length) { await runImport(files); if (files.length === 1) { const b = lib.books().find((x) => x.fileName === files[0].name && x.size === files[0].size); if (b) location.hash = '#/read/' + b.id; } }
    });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', async (e) => {
      if (e.data?.type === 'shared-files') pullShared();
    });
  }
  if (/[?&]shared=1/.test(location.search)) pullShared();
}
async function pullShared() {
  try {
    const cache = await caches.open('ink-share');
    const keys = await cache.keys();
    const files = [];
    for (const k of keys) {
      const res = await cache.match(k);
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('x-name') || 'shared'), { type: blob.type }));
      await cache.delete(k);
    }
    history.replaceState(null, '', location.pathname + location.hash);
    if (files.length) runImport(files);
  } catch { /* ignore */ }
}

/* ---------------- boot ---------------- */
async function boot() {
  await settings.load();
  settings.applyApp();
  buildNav();
  setupDrop();
  await lib.load();

  // keep sidebar fresh
  bus.on('library', renderSide);

  // bring over a previous Folio library once, without touching it
  try {
    if (!(await db.kvGet('legacyMigrated', false))) {
      const res = await migrateLegacy((s) => showPill({ name: s.name, sub: `Moving your library… ${s.i + 1} of ${s.n}`, pct: Math.round(((s.i + 1) / s.n) * 100) }));
      hidePill();
      await lib.load();
      if (res?.added) toast(`${res.added} book${res.added === 1 ? '' : 's'} brought over from your old library`);
    }
  } catch (e) { console.warn('legacy migration failed', e); hidePill(); }

  addEventListener('hashchange', route);
  await route();
  document.documentElement.classList.add('ready');
  $('#splash')?.remove();

  settings.on((k) => {
    if (k === 'library.view' || k === 'library.gridSize' || k === 'library.group' || k === 'library.showProgress') { /* views read settings on draw */ }
  });

  if (!(await db.kvGet('onboarded', false)) && !lib.books().length) await showOnboarding({ pickFiles });
  else if (!(await db.kvGet('onboarded', false))) await db.kvSet('onboarded', true);

  // library changes (edits, imports) re-render the current list views
  let t = 0;
  bus.on('library', () => { if (parse().parts[0] === 'read') return; clearTimeout(t); t = setTimeout(() => { const p = parse().parts[0] || ''; if (['', 'browse', 'series'].includes(p)) { const keep = viewEl.scrollTop; route().then(() => { viewEl.scrollTop = keep; }); } }, 60); });

  setupPwa();
  setTimeout(backfillCovers, 1200);
}

boot().catch((e) => {
  console.error(e);
  document.body.append(h('div', { class: 'boot-error' }, h('h2', null, 'INK couldn’t start.'), h('p', null, String(e?.message || e)),
    h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload')));
});
