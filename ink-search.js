/* INK — Search: titles, authors, series, file names, collections — and, on request, the text inside your books */
import { h, icon, debounce, pct } from './ink-util.js';
import * as lib from './ink-lib.js';
import { openBook } from './ink-cards.js';

function highlight(text, q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = document.createDocumentFragment();
  if (!toks.length) { out.append(text); return out; }
  const re = new RegExp('(' + toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig');
  String(text).split(re).forEach((part, i) => out.append(i % 2 ? h('mark', null, part) : part));
  return out;
}

export function gotoHit(bookId, location, q) {
  try { sessionStorage.setItem('ink-goto', JSON.stringify({ id: bookId, location, q })); } catch { /* ignore */ }
  openBook(bookId);
}

export function renderSearch(root, ctx, params) {
  let q = params.get('q') || '';
  let abort = null;
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search your library', value: q, 'aria-label': 'Search your library', autocomplete: 'off', enterkeyhint: 'search' });
  const results = h('div', { 'aria-live': 'polite' });
  const inner = h('div', { class: 'view-inner view-in' },
    h('header', { class: 'top' }, h('span', { class: 'wordmark small' }, 'INK')),
    h('h1', { class: 'page-title', style: { marginBottom: '16px' } }, 'Search'),
    h('div', { class: 'search-box' }, icon('search', 20), input),
    results);
  root.replaceChildren(inner);

  const run = () => {
    abort?.abort();
    q = input.value.trim();
    history.replaceState(null, '', '#/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
    results.replaceChildren();
    if (!q) {
      results.append(h('div', { class: 'empty', style: { minHeight: '40dvh' } }, h('p', null, 'Titles, authors, series, file names and collections.')));
      return;
    }
    const r = lib.search(q);
    if (r.collections.length) {
      results.append(h('section', { class: 'result-group' }, h('h2', { class: 'section-title', style: { marginBottom: '8px' } }, 'Collections'),
        h('div', { class: 'chips', style: { flexWrap: 'wrap', overflow: 'visible' } }, r.collections.map((c) => h('button', { class: 'chip', onclick: () => { location.hash = '#/browse?c=' + c.id; } }, icon('collection', 15), c.name)))));
    }
    if (r.books.length) {
      const list = h('div', { class: 'list' });
      for (const b of r.books.slice(0, 60)) {
        const s = lib.seriesOf(b);
        list.append(h('button', { class: 'result', onclick: () => openBook(b.id) },
          h('div', { class: 'cover' }, lib.coverImg(b.id)),
          h('div', { class: 'li-text' },
            h('div', { class: 'li-title' }, highlight(b.title, q)),
            h('div', { class: 'li-sub' }, highlight([b.author, s && s.name !== b.title ? s.name : '', lib.formatName(b)].filter(Boolean).join(' · '), q)),
            b.fileName && !b.fileName.toLowerCase().includes(b.title.toLowerCase()) && b.fileName.toLowerCase().includes(q.toLowerCase()) ? h('div', { class: 'result-snippet' }, highlight(b.fileName, q)) : null),
          h('span', { class: 'li-pct' }, lib.status(b) === 'unread' ? '' : pct(b.progress) + '%')));
      }
      results.append(h('section', { class: 'result-group' }, h('h2', { class: 'section-title' }, 'In your library'), list));
    } else if (!r.collections.length) {
      results.append(h('div', { class: 'hint-card' }, `Nothing in your library matches “${q}”.`));
    }
    results.append(insideBlock());
  };

  function insideBlock() {
    const wrap = h('section', { class: 'result-group' });
    const hits = h('div');
    const status = h('div', { class: 'row-hint', style: { margin: '10px 0' } });
    const btn = h('button', { class: 'btn ghost block', onclick: start }, icon('search', 18), `Search inside books for “${q}”`);
    wrap.append(btn, status, hits);
    async function start() {
      abort?.abort();
      const ac = abort = new AbortController();
      btn.disabled = true; hits.replaceChildren();
      const targets = lib.books().filter((b) => b.format !== 'comic' && !b.meta?.encrypted);
      let found = 0;
      for (let i = 0; i < targets.length; i++) {
        if (ac.signal.aborted) return;
        const b = targets[i];
        status.textContent = `Searching ${i + 1} of ${targets.length}: ${b.title}`;
        const group = h('div'); let n = 0, head;
        try {
          const mod = await (b.format === 'epub' ? import('./ink-engine-epub.js') : import('./ink-engine-pdf.js'));
          const { getFile } = await import('./ink-db.js');
          const blob = await getFile(b.id);
          if (!blob) continue;
          await mod.searchBlob(blob, q, {
            signal: ac.signal,
            onHit: (hit) => {
              if (n >= 5) return false;
              if (!head) { head = h('h3', { class: 'section-title', style: { margin: '18px 0 4px' } }, b.title); hits.append(head, group); }
              n++; found++;
              group.append(h('button', { class: 'result', onclick: () => gotoHit(b.id, hit.location, q) },
                h('div', { class: 'li-text' }, h('div', { class: 'li-sub' }, hit.label), h('div', { class: 'result-snippet' }, highlight(hit.snippet, q)))));
              return true;
            },
          });
        } catch (e) { if (ac.signal.aborted) return; console.warn('search failed for', b.title, e); }
      }
      status.textContent = found ? `${found} match${found === 1 ? '' : 'es'} inside your books.` : 'No matches inside your books.';
      btn.disabled = false;
    }
    return wrap;
  }

  input.addEventListener('input', debounce(run, 140));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  run();
  if (!q) setTimeout(() => input.focus({ preventScroll: true }), 80);
  return () => abort?.abort();
}
