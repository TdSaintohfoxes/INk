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

  /* ---------- DOM — minimal floating chrome (Apple Books–inspired, INK identity) ---------- */
  const stage = h('div', { class: 'rd-stage', tabindex: '-1' });
  const fab = (name, label, onclick, extra = '') =>
    h('button', { class: 'rd-fab ' + extra, 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); onclick(); } }, icon(name, 20));

  const closeBtn = fab('close', 'Close book', () => exit(), 'rd-fab-close');
  const bmBtn = fab('bookmark', 'Bookmark this page', () => toggleBookmark(), 'rd-fab-bm');
  const moreBtn = fab('more', 'Menu', () => openMore(), 'rd-fab-more');

  // Top strip: floating close | chapter status | bookmark + more
  const chapStatus = h('div', { class: 'rd-chap-status' });
  const top = h('header', { class: 'rd-top' },
    closeBtn,
    chapStatus,
    h('div', { class: 'rd-fab-group' }, bmBtn, moreBtn));

  // Bottom strip: chapter label, progress, seek
  const labelEl = h('span', { class: 'rd-label' });
  const subEl = h('span', { class: 'rd-sub' });
  const pageEl = h('div', { class: 'rd-page-num' }); // always subtle when chrome off
  const range = h('input', { type: 'range', class: 'rd-range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Position in book' });
  const prevCh = h('button', { class: 'rd-ch-btn', 'aria-label': 'Previous chapter', onclick: () => { api.interaction(); ctl?.prevChapter?.(); } }, icon('chevL', 18));
  const nextCh = h('button', { class: 'rd-ch-btn', 'aria-label': 'Next chapter', onclick: () => { api.interaction(); ctl?.nextChapter?.(); } }, icon('chevR', 18));
  const bottom = h('footer', { class: 'rd-bottom' },
    h('div', { class: 'rd-info' }, labelEl, subEl),
    h('div', { class: 'rd-seek' }, prevCh, range, nextCh));

  const loading = h('div', { class: 'rd-loading', role: 'status' }, h('div', { class: 'rd-spin' }), h('div', { class: 'rd-load-t' }, 'Opening…'));
  const rd = h('div', { class: 'rd chrome-on', 'data-format': book.format }, stage, top, bottom, pageEl, loading);
  root.replaceChildren(rd);

  function openMore() {
    api.interaction();
    const items = [
      { label: 'Contents', icon: 'toc', hint: book.format === 'comic' ? 'Pages & chapters' : 'Chapters & sections', onClick: () => openContents() },
      ctl?.search ? { label: 'Search', icon: 'search', hint: 'Find text in this book', onClick: () => openSearch() } : null,
      { label: 'Themes & settings', icon: 'type', hint: 'Font, theme, layout', onClick: () => openSettings() },
      { label: 'Bookmarks & highlights', icon: 'bookmark', hint: 'Your marks', onClick: () => openContents('marks') },
      book.format === 'epub' ? { label: 'Book info', icon: 'info', hint: 'Title, author, publisher', onClick: () => openContents('info') } : null,
    ].filter(Boolean);
    openSheet({
      title: book.title,
      size: 's',
      className: 'rd-more-sheet',
      body: () => h('div', { class: 'action-list' }, items.map((it) =>
        h('button', { class: 'action', onclick: () => { closeAllSheets(); setTimeout(it.onClick, 40); } },
          icon(it.icon, 20),
          h('span', { class: 'action-label' }, it.label),
          it.hint ? h('span', { class: 'action-hint' }, it.hint) : null))),
    });
  }

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
      // Top chapter status (e.g. "9 pages left in chapter") + bottom page number
      const pctVal = Math.round(clamp(info.progress || 0, 0, 1) * 100);
      chapStatus.textContent = info.chapLeft || info.label || '';
      pageEl.textContent = info.pageLabel || (pctVal + '%');
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
    bmBtn.replaceChildren(icon(on ? 'bookmarkOn' : 'bookmark', 20));
    bmBtn.classList.toggle('on', on);
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
    if (book.format === 'epub' || ctl?.packageInfo) tabs.push({ value: 'info', label: 'Info' });
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
      else if (tab === 'info') drawBookInfo(view);
      else drawThumbs(view, () => sheet.close());
    };
    sheet = openSheet({ title: book.title, size: 'l', className: 'panel', body: () => { draw(); return h('div', null, h('div', { class: 'panel-tabs' }, seg), view); } });
  }

  function drawBookInfo(view) {
    const info = ctl?.packageInfo?.() || {};
    const rows = [
      ['Title', info.title || book.title],
      ['Author', (info.authors || []).join(', ') || book.author || '—'],
      ['Series', info.series ? (info.seriesIndex != null ? `${info.series} · ${info.seriesIndex}` : info.series) : (book.series || '')],
      ['Publisher', info.publisher || book.meta?.publisher || ''],
      ['Published', info.pubDate || book.meta?.pubDate || ''],
      ['Language', info.language || book.meta?.language || ''],
      ['Chapters', info.chapters || ''],
      ['Format', info.format || book.format?.toUpperCase() || ''],
      ['File size', book.size ? (book.size > 1048576 ? (book.size / 1048576).toFixed(1) + ' MB' : Math.round(book.size / 1024) + ' KB') : ''],
      ['Progress', Math.round((book.progress || 0) * 100) + '%'],
      ['Added', book.dateAdded ? new Date(book.dateAdded).toLocaleDateString() : ''],
      ['Last opened', book.lastOpened ? new Date(book.lastOpened).toLocaleDateString() : ''],
    ].filter(([, v]) => v !== '' && v != null);
    const list = h('div', { class: 'book-info' });
    for (const [k, v] of rows) list.append(h('div', { class: 'info-row' }, h('div', { class: 'info-k' }, k), h('div', { class: 'info-v' }, String(v))));
    if (info.description) list.append(h('div', { class: 'info-desc' }, info.description));
    // Export annotations
    list.append(h('button', { class: 'btn ghost', style: { marginTop: '16px' }, onclick: () => exportAnnotations() }, 'Export highlights & bookmarks'));
    view.append(list);
  }

  async function exportAnnotations() {
    const [bms, hls] = await Promise.all([db.listBookmarks(book.id), db.listHighlights(book.id)]);
    if (!bms.length && !hls.length) { toast('No annotations to export'); return; }
    let md = `# ${book.title}\n`;
    if (book.author) md += `*${book.author}*\n`;
    md += `\n`;
    if (bms.length) {
      md += `## Bookmarks\n\n`;
      for (const m of bms) md += `- **${m.title || 'Bookmark'}** (${new Date(m.createdAt).toLocaleDateString()})\n`;
      md += `\n`;
    }
    if (hls.length) {
      md += `## Highlights\n\n`;
      for (const x of hls) {
        md += `> ${x.text}\n`;
        if (x.note) md += `\n*Note: ${x.note}*\n`;
        md += `\n— ${[x.label, new Date(x.createdAt).toLocaleDateString()].filter(Boolean).join(' · ')}\n\n`;
      }
    }
    try {
      const blob = new Blob([md], { type: 'text/markdown' });
      const a = h('a', { href: URL.createObjectURL(blob), download: (book.title || 'annotations').replace(/[^\w\- ]+/g, '').slice(0, 60) + ' — annotations.md' });
      document.body.append(a); a.click(); a.remove();
      toast('Annotations exported');
    } catch { toast('Couldn’t export'); }
  }

  async function drawToc(view, close) {
    const toc = await ctl.toc;
    if (!toc || !toc.length) {
      view.append(h('div', { class: 'hint-card' }, 'No table of contents found. You can still seek with the progress bar.'));
      return;
    }
    const list = h('div', { class: 'toc' });
    const collapsed = new Set(); // depths that are collapsed under a parent index
    const rows = [];

    const isHidden = (i) => {
      for (let j = i - 1; j >= 0; j--) {
        if (toc[j].depth < toc[i].depth) {
          if (collapsed.has(j)) return true;
          // keep walking up; only hide if an ancestor is collapsed
        } else if (toc[j].depth === toc[i].depth) break;
      }
      // check all ancestors
      let d = toc[i].depth;
      for (let j = i - 1; j >= 0 && d > 0; j--) {
        if (toc[j].depth < d) {
          if (collapsed.has(j)) return true;
          d = toc[j].depth;
        }
      }
      return false;
    };

    const render = () => {
      list.replaceChildren();
      const hereIdx = (() => { try { return ctl.tocIndex?.(); } catch { return null; } })();
      let hereEl = null;
      for (let i = 0; i < toc.length; i++) {
        if (isHidden(i)) continue;
        const t = toc[i];
        const depth = Math.min(t.depth || 0, 4);
        const open = t.hasChildren && !collapsed.has(i);
        const row = h('div', { class: 'toc-row' + (i === hereIdx ? ' here' : '') });
        if (t.hasChildren) {
          row.append(h('button', {
            class: 'toc-twist' + (open ? ' open' : ''),
            'aria-label': open ? 'Collapse' : 'Expand',
            'aria-expanded': open,
            onclick: (e) => { e.stopPropagation(); if (collapsed.has(i)) collapsed.delete(i); else collapsed.add(i); render(); },
          }, open ? '▾' : '▸'));
        } else {
          row.append(h('span', { class: 'toc-twist spacer' }));
        }
        const prog = typeof ctl.chapterProgress === 'function' ? ctl.chapterProgress(i) : 0;
        const btn = h('button', {
          class: 'toc-item d' + depth + (t.source === 'spine' ? ' detected' : ''),
          onclick: () => { close(); ctl.goTo(t.location); },
        },
          h('span', { class: 'toc-label' }, t.label),
          prog > 0.02 ? h('span', { class: 'toc-prog', 'aria-hidden': 'true' }, Math.round(prog * 100) + '%') : null);
        row.append(btn);
        list.append(row);
        if (i === hereIdx) hereEl = row;
      }
      if (hereEl) requestAnimationFrame(() => hereEl.scrollIntoView({ block: 'center' }));
    };

    // Auto-expand ancestors of the current chapter; collapse deep nests by default only if very large
    try {
      const hereIdx = ctl.tocIndex?.();
      if (toc.length > 80) {
        // collapse everything deeper than depth 0 initially, then expand path to current
        for (let i = 0; i < toc.length; i++) if (toc[i].hasChildren && toc[i].depth === 0) collapsed.add(i);
      }
      if (hereIdx != null) {
        let d = toc[hereIdx]?.depth ?? 0;
        for (let j = hereIdx - 1; j >= 0 && d > 0; j--) {
          if (toc[j].depth < d) { collapsed.delete(j); d = toc[j].depth; }
        }
      }
    } catch { /* ignore */ }

    view.append(list);
    render();
  }
  async function drawMarks(view, close) {
    marks = await db.listBookmarks(book.id);
    if (!marks.length) { view.append(h('div', { class: 'hint-card' }, 'No bookmarks yet. Tap the bookmark icon while reading.')); return; }
    const list = h('div', { class: 'list' });
    for (const m of marks) {
      list.append(h('div', { class: 'note-row' },
        h('button', { class: 'note-main', onclick: () => { close(); ctl.goTo(m.location); } },
          h('div', { class: 'note-title' }, m.title || 'Bookmark'),
          h('div', { class: 'note-sub' }, new Date(m.createdAt).toLocaleDateString())),
        h('button', { class: 'icon-btn', 'aria-label': 'Rename bookmark', onclick: async () => {
          const n = await promptDialog({ title: 'Rename bookmark', label: 'Name', value: m.title || '', confirmLabel: 'Save' });
          if (n == null) return;
          m.title = (n.trim() || m.title || 'Bookmark');
          try { await db.put('bookmarks', m); } catch {
            await db.deleteBookmark(m.id);
            const b = await db.addBookmark(book.id, m.location, m.title);
            Object.assign(m, b);
          }
          drawMarks(view.replaceChildren() || view, close);
        } }, icon('edit', 18)),
        h('button', { class: 'icon-btn', 'aria-label': 'Delete bookmark', onclick: async () => {
          await db.deleteBookmark(m.id); marks = marks.filter((x) => x.id !== m.id); refreshMarks(); drawMarks(view.replaceChildren() || view, close);
        } }, icon('trash', 18))));
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
    const sheet = openSheet({
      title: book.format === 'epub' ? 'Reading settings' : book.format === 'pdf' ? 'PDF settings' : 'Comic settings',
      size: 'l',
      className: 'panel rd-settings',
      body: (s) => ctl.settingsPanel(api, s),
    });
    // Always start at the top so Theme / Font are the first controls seen
    requestAnimationFrame(() => {
      const body = sheet?.body || sheet?.el?.querySelector?.('.sheet-body');
      if (body) body.scrollTop = 0;
    });
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
      stats.begin(book.id);
      lib.touchOpened(book.id);
      await loadMarks();
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
