/* INK — Library browser (grid/list, sort, filter, collections) and series pages */
import { h, icon } from './ink-util.js';
import * as lib from './ink-lib.js';
import * as settings from './ink-settings.js';
import { bookCard, seriesCard, listItem, coverEl, collectionOptions, openBook } from './ink-cards.js';
import { openSheet, actionSheet, promptDialog, confirmDialog, segmented } from './ink-ui.js';
import * as db from './ink-db.js';

const TITLES = { all: 'Library', epub: 'Books', comic: 'Comics', pdf: 'PDFs' };

export function renderBrowse(root, ctx, params) {
  const L = settings.get('library');
  let filter = params.get('f') || 'all';
  const cid = params.get('c');
  const sid = params.get('s');
  const collection = cid ? lib.collections().find((c) => c.id === cid) : null;
  const smart = sid ? lib.SMART.find((s) => s.id === sid) : null;
  if (cid && !collection) { location.replace('#/'); return; }

  const title = collection ? collection.name : smart ? smart.name : TITLES[filter] || 'Library';
  const inner = h('div', { class: 'view-inner view-in' });
  root.replaceChildren(inner);

  const base = () => collection ? lib.collectionBooks(collection.id) : smart ? smart.get() : lib.books();
  const content = h('div');
  const count = h('span', { class: 'count-line' });

  const chipRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' });
  const drawChips = () => {
    chipRow.replaceChildren(...lib.FILTERS.map(([k, label]) => h('button', { class: 'chip' + (filter === k ? ' on' : ''), 'aria-pressed': filter === k, onclick: () => { filter = k; history.replaceState(null, '', setParam(location.hash, 'f', k === 'all' ? '' : k)); drawChips(); draw(); } }, label)));
  };

  const viewToggle = segmentedIcons();
  viewToggle.addEventListener('viewchange', () => draw());
  const sortBtn = h('button', { class: 'chip', 'aria-label': 'Sort', onclick: () => sortSheet(() => { sortBtn.lastChild.textContent = sortLabel(); draw(); }) }, icon('swap', 15), h('span', null, sortLabel()));

  inner.append(
    h('header', { class: 'top', style: { marginBottom: '0' } },
      h('button', { class: 'crumb', onclick: () => history.length > 1 && !collection ? history.back() : (location.hash = '#/') }, icon('chevL', 18), 'Library'),
      h('div', { class: 'top-actions' },
        collection ? h('button', { class: 'icon-btn', 'aria-label': 'Collection options', onclick: () => collectionOptions(collection, { onDeleted: () => { location.hash = '#/'; } }) }, icon('more', 22)) : null,
        h('button', { class: 'icon-btn', 'aria-label': 'Import books', onclick: ctx.importMenu }, icon('plus', 24)))),
    h('h1', { class: 'page-title', style: { margin: '2px 0 14px' } }, title),
    chipRow,
    h('div', { class: 'toolbar' }, count, h('span', { class: 'spacer' }), sortBtn, viewToggle),
    content);

  drawChips();
  draw();

  function draw() {
    const S = settings.get('library');
    let list = lib.applyFilter(base(), filter);
    list = lib.sortBooks(list, S.sort, S.sortDir);
    count.textContent = list.length + (list.length === 1 ? ' item' : ' items');
    content.replaceChildren();
    if (!list.length) {
      content.append(h('div', { class: 'empty', style: { minHeight: '40dvh' } },
        h('h2', null, filter === 'all' && !collection && !smart ? 'Nothing here yet.' : 'Nothing to show.'),
        h('p', null, collection ? 'Add books from their ⋮ menu.' : filter === 'all' ? 'Import something to read.' : 'Try another filter.'),
        filter !== 'all' ? h('button', { class: 'btn ghost', onclick: () => { filter = 'all'; drawChips(); draw(); } }, 'Show everything') : null));
      return;
    }
    const grouped = S.group && ['all', 'epub', 'pdf', 'comic'].includes(filter) && !collection ? lib.groupSeries(list) : list.map((b) => ({ type: 'book', book: b }));
    if (S.view === 'list') {
      content.append(h('div', { class: 'list' }, grouped.map((g) => g.type === 'book' ? listItem(g.book) : seriesListItem(g))));
    } else {
      content.append(h('div', { class: 'grid', 'data-size': S.gridSize }, grouped.map((g) => g.type === 'book' ? bookCard(g.book) : seriesCard(g))));
    }
  }
}

function seriesListItem(g) {
  const first = g.books[0];
  return h('button', { class: 'li', onclick: () => { location.hash = '#/series/' + g.key; } },
    h('div', { class: 'cover' }, lib.coverImg(first.id)),
    h('div', { class: 'li-text' }, h('div', { class: 'li-title' }, g.name), h('div', { class: 'li-sub' }, g.books.length + ' volumes')),
    h('span', { class: 'li-pct' }, icon('chevR', 16)));
}

function sortLabel() { const k = settings.get('library.sort'); return (lib.SORTS.find((s) => s[0] === k) || [])[1] || 'Sort'; }
function sortSheet(done) {
  openSheet({
    title: 'Sort by', size: 's', className: 'actions',
    body: (api) => h('div', { class: 'action-list' }, lib.SORTS.map(([k, label]) => {
      const on = settings.get('library.sort') === k;
      return h('button', { class: 'action', onclick: () => {
        if (on) settings.set('library.sortDir', settings.get('library.sortDir') === 'asc' ? 'desc' : 'asc');
        else { settings.set('library.sort', k); settings.set('library.sortDir', lib.defaultDir(k)); }
        api.close(); done();
      } }, h('span', { class: 'action-label' }, label), on ? icon(settings.get('library.sortDir') === 'asc' ? 'chevD' : 'chevD', 16) : null,
      on ? h('span', { class: 'action-hint' }, settings.get('library.sortDir') === 'asc' ? 'Ascending' : 'Descending') : null);
    })),
  });
}
function segmentedIcons() {
  const el = h('div', { class: 'seg-icons', role: 'group', 'aria-label': 'View' });
  const mk = (v, ic, label) => h('button', { class: settings.get('library.view') === v ? 'on' : '', 'aria-label': label, 'aria-pressed': settings.get('library.view') === v,
    onclick: () => { settings.set('library.view', v); [...el.children].forEach((c) => { c.classList.toggle('on', c === btn(v)); c.setAttribute('aria-pressed', c === btn(v)); }); el.dispatchEvent(new CustomEvent('viewchange', { bubbles: true })); } }, icon(ic, 18));
  const g = mk('grid', 'grid', 'Cover grid'), l = mk('list', 'list', 'List');
  const btn = (v) => (v === 'grid' ? g : l);
  el.append(g, l);
  return el;
}
function setParam(hash, key, val) {
  const [path, qs = ''] = hash.split('?');
  const p = new URLSearchParams(qs);
  if (val) p.set(key, val); else p.delete(key);
  const s = p.toString();
  return path + (s ? '?' + s : '');
}

/* ---------------- series page ---------------- */
export function renderSeries(root, ctx, key) {
  const vols = lib.seriesBooks(key);
  if (!vols.length) { location.replace('#/'); return; }
  const name = lib.seriesOf(vols[0]).name;
  const read = vols.filter((b) => lib.status(b) === 'finished').length;
  const next = vols.find((b) => lib.status(b) === 'reading') || vols.find((b) => lib.status(b) === 'unread') || vols[0];
  const inner = h('div', { class: 'view-inner view-in' });
  root.replaceChildren(inner);
  inner.append(
    h('header', { class: 'top' },
      h('button', { class: 'crumb', onclick: () => history.back() }, icon('chevL', 18), 'Back'),
      h('div', { class: 'top-actions' }, h('button', { class: 'icon-btn', 'aria-label': 'Series options', onclick: () => seriesOptions(key, name, vols) }, icon('more', 22)))),
    h('div', { class: 'series-head' },
      h('div', { class: 'cover' }, lib.coverImg(vols[0].id)),
      h('div', null, h('h1', { class: 'page-title' }, name),
        h('div', { class: 'meta-line' }, `${vols.length} volumes · ${read} read`),
        h('button', { class: 'btn primary', style: { marginTop: '14px' }, onclick: () => openBook(next.id) }, icon('arrowR', 18), lib.status(next) === 'reading' ? 'Continue ' + (lib.volumeLabel(next) || '') : 'Start ' + (lib.volumeLabel(next) || 'reading')))),
    h('div', { class: 'grid', 'data-size': settings.get('library.gridSize') }, vols.map((b) => bookCard(b, { sub: [lib.volumeLabel(b), lib.progressLabel(b)].filter(Boolean).join(' · ') }))));
}

function seriesOptions(key, name, vols) {
  actionSheet(name, [
    { label: 'Rename series…', icon: 'edit', onClick: async () => {
      const n = await promptDialog({ title: 'Rename series', value: name });
      if (!n || !n.trim()) return;
      for (const b of vols) { const s = lib.seriesOf(b); await db.patchBook(b.id, { series: n.trim(), seriesNumber: s?.number ?? null, seriesLocked: false }, { silent: true }); }
      await lib.load(); location.hash = '#/series/' + lib.seriesOf(lib.byId(vols[0].id)).key;
    } },
    { label: 'Ungroup these books', icon: 'split', onClick: async () => {
      if (!await confirmDialog({ title: 'Ungroup series?', message: 'Each volume will appear on its own. You can regroup them any time from Edit details.', confirmLabel: 'Ungroup' })) return;
      for (const b of vols) await db.patchBook(b.id, { series: '', seriesNumber: null, seriesLocked: true }, { silent: true });
      await lib.load(); location.hash = '#/';
    } },
  ]);
}
