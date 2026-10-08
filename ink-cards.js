/* INK — book cards, series cards and the per-book actions (options, edit, collections) */
import { h, icon, pct } from './ink-util.js';
import * as lib from './ink-lib.js';
import * as db from './ink-db.js';
import { openSheet, actionSheet, confirmDialog, promptDialog, toast, field } from './ink-ui.js';

export const openBook = (id) => { location.hash = '#/read/' + id; };

export function longPress(el, fn, ms = 520) {
  let t = 0, fired = false, x = 0, y = 0;
  const cancel = () => clearTimeout(t);
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    fired = false; x = e.clientX; y = e.clientY;
    t = setTimeout(() => { fired = true; navigator.vibrate?.(8); fn(e); }, ms);
  });
  el.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - x) > 8 || Math.abs(e.clientY - y) > 8) cancel(); });
  ['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((ev) => el.addEventListener(ev, cancel));
  el.addEventListener('click', (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(e); });
}

export function coverEl(b, { showProgress = true } = {}) {
  const c = h('div', { class: 'cover' }, lib.coverImg(b.id));
  const st = lib.status(b);
  if (b.favorite) c.append(h('span', { class: 'fav' }, icon('heartOn', 16)));
  if (st === 'finished') c.append(h('span', { class: 'done', title: 'Finished' }, icon('check', 13)));
  else if (st === 'reading' && showProgress) c.append(h('div', { class: 'bar' }, h('i', { style: { width: pct(b.progress) + '%' } })));
  return c;
}

export function bookCard(b, { sub } = {}) {
  const label = b.title + (b.author ? ' — ' + b.author : '');
  const btn = h('button', { class: 'card-cover-btn', 'aria-label': 'Open ' + label, onclick: () => openBook(b.id) }, coverEl(b));
  const more = h('button', { class: 'card-more', 'aria-label': 'Options for ' + b.title, onclick: (e) => { e.stopPropagation(); bookActions(b); } }, icon('more', 18));
  longPress(btn, () => bookActions(b));
  const subtitle = sub ?? (lib.volumeLabel(b) || b.author || lib.formatName(b));
  return h('article', { class: 'card', dataset: { id: b.id } }, btn,
    h('div', { class: 'card-meta' }, h('div', { class: 'card-text' }, h('div', { class: 'card-title' }, b.title), h('div', { class: 'card-sub' }, subtitle)), more));
}

export function seriesCard(g) {
  const first = g.books.find((b) => lib.status(b) === 'reading') || g.books[0];
  const read = g.books.filter((b) => lib.status(b) === 'finished').length;
  const cover = h('div', { class: 'cover-wrap stack' }, h('div', { class: 'cover' }, lib.coverImg(first.id), h('span', { class: 'badge-count' }, g.books.length)));
  const btn = h('button', { class: 'card-cover-btn', 'aria-label': `Series ${g.name}, ${g.books.length} volumes`, onclick: () => { location.hash = '#/series/' + g.key; } }, cover);
  return h('article', { class: 'card' }, btn,
    h('div', { class: 'card-meta' }, h('div', { class: 'card-text' }, h('div', { class: 'card-title' }, g.name), h('div', { class: 'card-sub' }, `${g.books.length} volumes${read ? ' · ' + read + ' read' : ''}`))));
}

export function listItem(b) {
  const btn = h('button', { class: 'li', 'aria-label': 'Open ' + b.title, onclick: () => openBook(b.id) },
    coverEl(b, { showProgress: false }),
    h('div', { class: 'li-text' }, h('div', { class: 'li-title' }, b.title), h('div', { class: 'li-sub' }, [b.author, lib.volumeLabel(b), lib.formatName(b)].filter(Boolean).join(' · '))),
    h('span', { class: 'li-pct' }, lib.status(b) === 'unread' ? '' : lib.status(b) === 'finished' ? '100%' : pct(b.progress) + '%'));
  longPress(btn, () => bookActions(b));
  return h('div', { class: 'li-wrap', style: { display: 'flex', alignItems: 'center' } }, btn,
    h('button', { class: 'card-more', 'aria-label': 'Options for ' + b.title, onclick: () => bookActions(b) }, icon('more', 18)));
}

/* ---------------- actions ---------------- */
export function bookActions(b) {
  b = lib.byId(b.id) || b;
  const st = lib.status(b);
  actionSheet(b.title, [
    { label: st === 'reading' ? 'Continue reading' : st === 'finished' ? 'Read again' : 'Open', icon: 'book', onClick: () => openBook(b.id) },
    { label: b.favorite ? 'Remove from favorites' : 'Add to favorites', icon: b.favorite ? 'heartOn' : 'heart', onClick: () => lib.setFavorite(b.id, !b.favorite) },
    { label: 'Add to collection…', icon: 'collection', onClick: () => collectionsSheet(b) },
    st === 'finished' || st === 'reading'
      ? { label: 'Mark as unread', icon: 'close', onClick: () => lib.markUnread(b.id) }
      : { label: 'Mark as finished', icon: 'check', onClick: () => lib.markFinished(b.id) },
    { label: 'Edit details…', icon: 'edit', onClick: () => editSheet(b) },
    { label: 'Remove from library', icon: 'trash', danger: true, onClick: () => removeFlow(b) },
  ]);
}

export async function removeFlow(b) {
  const ok = await confirmDialog({
    title: 'Remove from library?',
    message: `“${b.title}” will be removed from INK along with its bookmarks and highlights. The original file on your device is not touched.`,
    confirmLabel: 'Remove', danger: true,
  });
  if (!ok) return false;
  await lib.removeBook(b.id);
  toast('Removed “' + b.title + '”');
  return true;
}

export function editSheet(b) {
  const s = lib.seriesOf(b);
  const init = { series: s?.name || '', number: s?.number ?? '' };
  const f = {
    title: h('input', { class: 'input', value: b.title, 'aria-label': 'Title' }),
    author: h('input', { class: 'input', value: b.author || '', 'aria-label': 'Author' }),
    series: h('input', { class: 'input', value: init.series, placeholder: 'None', 'aria-label': 'Series' }),
    number: h('input', { class: 'input', type: 'number', step: 'any', inputmode: 'decimal', value: init.number, placeholder: '—', 'aria-label': 'Volume number' }),
  };
  openSheet({
    title: 'Edit details',
    body: (api) => h('div', null,
      field('Title', f.title), field('Author', f.author),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 110px', gap: '10px' } }, field('Series', f.series), field('Volume', f.number)),
      h('p', { class: 'row-hint' }, s?.auto ? 'This series was guessed from the file names. Change or clear it if it is wrong — nothing else is affected.' : 'Books with the same series name are grouped together.'),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn ghost', onclick: () => api.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const touched = f.series.value.trim() !== init.series || String(f.number.value) !== String(init.number);
          if (touched) await lib.editBook(b.id, { title: f.title.value, author: f.author.value, series: f.series.value, seriesNumber: f.number.value });
          else await db.patchBook(b.id, { title: f.title.value.trim() || b.title, author: f.author.value.trim() });
          api.close();
        } }, 'Save'))),
  });
}

export function collectionsSheet(b) {
  openSheet({
    title: 'Collections',
    body: (api) => {
      const list = h('div');
      const draw = () => {
        list.replaceChildren();
        const mine = new Set(lib.collectionsOf(b.id).map((c) => c.id));
        if (!lib.collections().length) list.append(h('p', { class: 'row-hint', style: { margin: '8px 0 14px' } }, 'Collections group books without copying them — a book can be in several.'));
        for (const c of lib.collections()) {
          const row = h('button', { class: 'check-row' + (mine.has(c.id) ? ' on' : ''), role: 'checkbox', 'aria-checked': mine.has(c.id),
            onclick: async () => { await db.setMembership(c.id, b.id, !mine.has(c.id)); await lib.load(); draw(); } },
            h('span', { class: 'box' }, icon('check', 14)), h('span', null, c.name));
          list.append(row);
        }
      };
      draw();
      const input = h('input', { class: 'input', placeholder: 'New collection…', 'aria-label': 'New collection name' });
      const add = async () => {
        const name = input.value.trim();
        if (!name) return;
        const c = await db.createCollection(name);
        await db.setMembership(c.id, b.id, true);
        await lib.load(); input.value = ''; draw();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      return h('div', null, list, h('div', { style: { display: 'flex', gap: '8px', marginTop: '14px' } }, input, h('button', { class: 'btn primary', onclick: add }, 'Add')));
    },
  });
}

export async function collectionOptions(c, { onDeleted } = {}) {
  actionSheet(c.name, [
    { label: 'Rename…', icon: 'edit', onClick: async () => { const n = await promptDialog({ title: 'Rename collection', value: c.name }); if (n && n.trim()) db.renameCollection(c.id, n); } },
    { label: 'Delete collection', icon: 'trash', danger: true, onClick: async () => {
      if (await confirmDialog({ title: 'Delete collection?', message: 'The books stay in your library.', confirmLabel: 'Delete', danger: true })) { await db.deleteCollection(c.id); onDeleted?.(); }
    } },
  ]);
}

export async function newCollection() {
  const n = await promptDialog({ title: 'New collection', label: 'Name', placeholder: 'Fantasy, Manga, University…', confirmLabel: 'Create' });
  if (n && n.trim()) { const c = await db.createCollection(n); return c; }
  return null;
}
