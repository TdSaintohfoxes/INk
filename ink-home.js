/* INK — Home: what you're reading, what's new, and ways into the library */
import { h, icon, greeting, pct } from './ink-util.js';
import * as lib from './ink-lib.js';
import { bookCard, seriesCard, openBook, newCollection } from './ink-cards.js';
import * as stats from './ink-stats.js';
import * as settings from './ink-settings.js';
import { showStats } from './ink-settings-ui.js';

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
  else { const first = lib.recentlyAdded(1)[0]; if (first) inner.append(hero(first, 'Start reading')); }
  const todaySlot = h('div', { class: 'today-slot' });
  inner.append(todaySlot);
  todayCard(todaySlot);
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

const NS = 'http://www.w3.org/2000/svg';
function miniRing(frac) {
  const R = 18, C = 2 * Math.PI * R;
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 44 44'); svg.setAttribute('class', 'today-ring goal-ring');
  const mk = (cls, dash) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', 22); c.setAttribute('cy', 22); c.setAttribute('r', R); c.setAttribute('class', cls); c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', 4.5); c.setAttribute('stroke-linecap', 'round'); if (dash != null) { c.setAttribute('stroke-dasharray', `${C} ${C}`); c.setAttribute('stroke-dashoffset', String(C * (1 - dash))); c.setAttribute('transform', 'rotate(-90 22 22)'); } return c; };
  svg.append(mk('goal-track'), mk('goal-fill', Math.min(1, frac)));
  return svg;
}
async function todayCard(slot) {
  let s; try { s = await stats.summary(); } catch { return; }
  const goal = +settings.get('reading.dailyGoal') || 0, min = Math.floor(s.todaySeconds / 60);
  if (!goal && !s.streak && !s.totalSeconds) return;
  const frac = goal ? s.todaySeconds / (goal * 60) : 0;
  const title = goal ? `${min} of ${goal} min today` : `${min} min today`;
  const sub = s.streak ? `${s.streak} day streak` + (goal && frac >= 1 ? ' · goal reached' : '') : goal ? 'Read a little to start a streak' : 'Set a daily goal in your stats';
  slot.replaceChildren(h('button', { class: 'today-card', 'aria-label': 'Open reading statistics', onclick: showStats },
    miniRing(goal ? frac : Math.min(1, s.todaySeconds / 1200)), h('div', { class: 'today-t' }, h('b', null, title), h('span', null, sub)), icon('chevR', 18)));
}

function hero(b, label = 'Continue reading') {
  const bg = h('div', { class: 'hero-bg' });
  lib.coverUrl(b.id).then((u) => { if (u) bg.style.backgroundImage = `url("${u}")`; });
  const sub = [b.author, b.lastLabel].filter(Boolean).join(' · ') || lib.formatName(b);
  return h('section', { class: 'section', style: { marginTop: '0' } },
    h('div', { class: 'hero', role: 'button', tabindex: '0', 'aria-label': `${label} ${b.title}`, onclick: () => openBook(b.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(b.id); } } },
      bg,
      h('div', { class: 'cover' }, lib.coverImg(b.id)),
      h('div', null,
        h('div', { class: 'hero-label' }, label),
        h('div', { class: 'hero-title' }, b.title),
        h('div', { class: 'hero-sub' }, sub),
        h('div', { class: 'hero-prog', role: 'progressbar', 'aria-valuenow': pct(b.progress), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: pct(b.progress) + '%' } })),
        h('div', { class: 'hero-foot' }, h('span', null, b.progress > 0 ? pct(b.progress) + '% complete' : 'Not started'), h('span', { class: 'hero-go' }, label === 'Start reading' ? 'Start' : 'Continue', icon('arrowR', 18))))));
}
