/* INK — Home: what you're reading, what's new, and ways into the library */
import { h, icon, greeting, pct } from './ink-util.js';
import * as lib from './ink-lib.js';
import { bookCard, seriesCard, openBook, newCollection } from './ink-cards.js';

export function renderHome(root, ctx) {
  const all = lib.books();
  const inner = h('div', { class: 'view-inner view-in' });
  root.replaceChildren(inner);

  inner.append(h('header', { class: 'top' },
    h('span', { class: 'wordmark small' }, 'INK'),
    h('div', { class: 'top-actions' }, h('button', { class: 'icon-btn', 'aria-label': 'Import books', onclick: ctx.importMenu }, icon('plus', 24)))));

  if (!all.length) {
    inner.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-mark', 'aria-hidden': 'true' }),
      h('h2', null, 'Your library is empty.'),
      h('p', null, 'Bring something to read.'),
      h('button', { class: 'btn primary', style: { marginTop: '14px' }, onclick: ctx.pickFiles }, icon('plus', 18), 'Import Books'),
      h('div', { class: 'fmts' }, 'EPUB · PDF · CBR · CBZ')));
    return;
  }

  inner.append(h('h1', { class: 'greet' }, greeting()));

  const reading = lib.continueReading();
  if (reading.length) inner.append(hero(reading[0]));
  if (reading.length > 1) inner.append(shelfSection('Also reading', reading.slice(1, 12)));

  const recent = lib.recentlyAdded(14);
  inner.append(shelfSection('Recently added', recent, { all: '#/browse?s=recent' }));

  const counts = { epub: 0, comic: 0, pdf: 0 };
  all.forEach((b) => counts[b.format]++);
  const tile = (label, f, n, ic) => h('button', { class: 'tile', onclick: () => { location.hash = '#/browse?f=' + f; } },
    h('span', { class: 'tile-label' }, icon(ic, 16), label), h('span', { class: 'tile-count' }, n));
  inner.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Browse')),
    h('div', { class: 'tiles' }, tile('Books', 'epub', counts.epub, 'book'), tile('Comics', 'comic', counts.comic, 'comic'), tile('PDFs', 'pdf', counts.pdf, 'pdf'))));

  // collections
  const smart = lib.SMART.filter((s) => ['favorites', 'unread', 'finished'].includes(s.id)).map((s) => ({ ...s, n: s.get().length })).filter((s) => s.n);
  const cols = lib.collections();
  const row = h('div', { class: 'coll-row' });
  for (const s of smart) row.append(collBtn(s.name, s.n, '#/browse?s=' + s.id));
  for (const c of cols) row.append(collBtn(c.name, lib.collectionBooks(c.id).length, '#/browse?c=' + c.id));
  row.append(h('button', { class: 'chip dashed', style: { alignSelf: 'center' }, onclick: async () => { const c = await newCollection(); if (c) location.hash = '#/browse?c=' + c.id; } }, icon('plus', 15), 'New collection'));
  inner.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Collections')), row));

  // series
  const groups = lib.groupSeries(all).filter((g) => g.type === 'series');
  if (groups.length) {
    const shelf = h('div', { class: 'shelf' }, groups.slice(0, 14).map((g) => seriesCard(g)));
    inner.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Series')), shelf));
  }
}

function collBtn(name, n, href) {
  return h('button', { class: 'coll', onclick: () => { location.hash = href; } }, h('div', { class: 'coll-name' }, name), h('div', { class: 'coll-n' }, n + (n === 1 ? ' item' : ' items')));
}

function shelfSection(title, list, { all } = {}) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, title),
      all ? h('button', { class: 'link-btn', onclick: () => { location.hash = all; } }, 'See all', icon('chevR', 14)) : null),
    h('div', { class: 'shelf' }, list.map((b) => bookCard(b))));
}

function hero(b) {
  const bg = h('div', { class: 'hero-bg' });
  lib.coverUrl(b.id).then((u) => { if (u) bg.style.backgroundImage = `url("${u}")`; });
  const sub = [b.author, b.lastLabel].filter(Boolean).join(' · ') || lib.formatName(b);
  return h('section', { class: 'section', style: { marginTop: '0' } },
    h('div', { class: 'hero', role: 'button', tabindex: '0', 'aria-label': `Continue reading ${b.title}`, onclick: () => openBook(b.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(b.id); } } },
      bg,
      h('div', { class: 'cover' }, lib.coverImg(b.id)),
      h('div', null,
        h('div', { class: 'hero-label' }, 'Continue reading'),
        h('div', { class: 'hero-title' }, b.title),
        h('div', { class: 'hero-sub' }, sub),
        h('div', { class: 'hero-prog', role: 'progressbar', 'aria-valuenow': pct(b.progress), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: pct(b.progress) + '%' } })),
        h('div', { class: 'hero-foot' }, h('span', null, pct(b.progress) + '% complete'), h('span', { class: 'hero-go' }, 'Continue', icon('arrowR', 18))))));
}
