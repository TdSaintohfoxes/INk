/* INK — library data service: cached books, series grouping, smart collections, sort/filter/search, cover URLs */
import * as db from './ink-db.js';
import * as settings from './ink-settings.js';
import { bus, natCompare, pct, debounce } from './ink-util.js';
import { seriesKey, fmtNumber } from './ink-meta.js';

let BOOKS = [], COLLECTIONS = [], LINKS = [];
let autoCounts = new Map();

export const books = () => BOOKS;
export const collections = () => COLLECTIONS;
export const byId = (id) => BOOKS.find((b) => b.id === id) || null;

export async function load() {
  [BOOKS, COLLECTIONS, LINKS] = await Promise.all([db.listBooks(), db.listCollections(), db.allLinks()]);
  autoCounts = new Map();
  for (const b of BOOKS) {
    if (!b.series && !b.seriesLocked && b.meta?.seriesAuto) {
      const k = seriesKey(b.meta.seriesAuto.series);
      autoCounts.set(k, (autoCounts.get(k) || 0) + 1);
    }
  }
}
const reload = debounce(async () => { await load(); bus.emit('library'); }, 30);
bus.on('books', reload);
bus.on('collections', reload);

/* ---------------- series ---------------- */
/** {key,name,number} or null. Automatic guesses only count when 2+ books agree, and never override the user. */
export function seriesOf(b) {
  if (b.series) return { key: seriesKey(b.series), name: b.series, number: b.seriesNumber ?? null };
  if (b.seriesLocked) return null;
  const a = b.meta?.seriesAuto;
  if (a && (autoCounts.get(seriesKey(a.series)) || 0) >= 2) return { key: seriesKey(a.series), name: a.series, number: a.number ?? null, auto: true };
  return null;
}
export function seriesBooks(key) {
  return BOOKS.filter((b) => seriesOf(b)?.key === key)
    .sort((a, b) => (seriesOf(a).number ?? 1e9) - (seriesOf(b).number ?? 1e9) || natCompare(a.title, b.title));
}
export function seriesName(key) { const b = seriesBooks(key)[0]; return b ? seriesOf(b).name : ''; }
export const volumeLabel = (b) => { const s = seriesOf(b); return s?.number != null ? 'Vol. ' + fmtNumber(s.number) : ''; };

/** Replace books of the same series by one entry. -> [{type:'book',book}|{type:'series',key,name,books}] */
export function groupSeries(list) {
  const out = [], seen = new Map();
  for (const b of list) {
    const s = seriesOf(b);
    if (!s) { out.push({ type: 'book', book: b }); continue; }
    let g = seen.get(s.key);
    if (!g) { g = { type: 'series', key: s.key, name: s.name, books: [] }; seen.set(s.key, g); out.push(g); }
    g.books.push(b);
  }
  for (const g of out) if (g.type === 'series') {
    g.books.sort((a, b) => (seriesOf(a).number ?? 1e9) - (seriesOf(b).number ?? 1e9));
    if (g.books.length === 1) { const i = out.indexOf(g); out[i] = { type: 'book', book: g.books[0] }; }
  }
  return out;
}

/* ---------------- status & labels ---------------- */
export function status(b) {
  if (b.progress >= 0.985) return 'finished';
  if (b.dateFinished && b.progress >= 0.9) return 'finished';
  return b.progress > 0.004 ? 'reading' : 'unread';
}
export function progressLabel(b) {
  const p = pct(b.progress);
  if (status(b) === 'finished') return 'Finished';
  if (status(b) === 'unread') return b.format === 'epub' ? 'New' : (b.meta?.pages ? b.meta.pages + ' pages' : 'New');
  return (b.lastLabel ? b.lastLabel + ' · ' : '') + p + '%';
}
export const formatName = (b) => (b.format === 'comic' ? (b.ext === 'cbr' ? 'CBR' : 'CBZ') : b.format.toUpperCase());

/* ---------------- lists ---------------- */
const byOpened = (a, b) => (b.lastOpened || 0) - (a.lastOpened || 0);
export const continueReading = () => BOOKS.filter((b) => status(b) === 'reading').sort(byOpened);
export const recentlyAdded = (n = 30) => [...BOOKS].sort((a, b) => b.dateAdded - a.dateAdded).slice(0, n);
export const recentlyFinished = () => BOOKS.filter((b) => b.dateFinished && status(b) === 'finished').sort((a, b) => b.dateFinished - a.dateFinished);
export const unread = () => BOOKS.filter((b) => status(b) === 'unread');
export const favorites = () => BOOKS.filter((b) => b.favorite);

export const SMART = [
  { id: 'continue', name: 'Continue Reading', get: continueReading },
  { id: 'recent', name: 'Recently Added', get: () => recentlyAdded(40) },
  { id: 'finished', name: 'Recently Finished', get: recentlyFinished },
  { id: 'unread', name: 'Unread', get: unread },
  { id: 'favorites', name: 'Favorites', get: favorites },
];
export function collectionBooks(cid) {
  const ids = new Set(LINKS.filter((l) => l.collectionId === cid).map((l) => l.bookId));
  return BOOKS.filter((b) => ids.has(b.id));
}
export const collectionsOf = (bid) => COLLECTIONS.filter((c) => LINKS.some((l) => l.collectionId === c.id && l.bookId === bid));

export const FILTERS = [
  ['all', 'All'], ['epub', 'EPUB'], ['pdf', 'PDF'], ['comic', 'Comics'], ['unread', 'Unread'], ['reading', 'Reading'], ['finished', 'Finished'], ['favorites', 'Favorites'],
];
export function applyFilter(list, f) {
  switch (f) {
    case 'epub': case 'pdf': case 'comic': return list.filter((b) => b.format === f);
    case 'unread': case 'reading': case 'finished': return list.filter((b) => status(b) === f);
    case 'favorites': return list.filter((b) => b.favorite);
    default: return list;
  }
}
export const SORTS = [
  ['added', 'Recently added'], ['opened', 'Recently opened'], ['title', 'Title'], ['author', 'Author'], ['progress', 'Progress'], ['modified', 'Date modified'],
];
export function sortBooks(list, key, dir = 'desc') {
  const mul = (d) => (dir === d ? 1 : -1);
  const cmp = {
    added: (a, b) => (b.dateAdded - a.dateAdded) * mul('desc'),
    opened: (a, b) => ((b.lastOpened || 0) - (a.lastOpened || 0)) * mul('desc'),
    title: (a, b) => natCompare(a.title.replace(/^(the|a|an)\s+/i, ''), b.title.replace(/^(the|a|an)\s+/i, '')) * mul('asc'),
    author: (a, b) => (natCompare(a.author || '￿', b.author || '￿') || natCompare(a.title, b.title)) * mul('asc'),
    progress: (a, b) => (b.progress - a.progress) * mul('desc'),
    modified: (a, b) => ((b.dateModified || 0) - (a.dateModified || 0)) * mul('desc'),
  }[key] || (() => 0);
  return [...list].sort(cmp);
}
export const defaultDir = (key) => (['title', 'author'].includes(key) ? 'asc' : 'desc');

/* ---------------- search (titles, authors, series, file names, collections) ---------------- */
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
export function search(q) {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  if (!toks.length) return { books: [], collections: [] };
  const scored = [];
  for (const b of BOOKS) {
    const s = seriesOf(b);
    const cols = collectionsOf(b.id).map((c) => c.name).join(' ');
    const fields = [[norm(b.title), 6], [norm(b.author), 4], [norm(s?.name), 4], [norm(b.fileName), 2], [norm(cols), 1]];
    let total = 0, ok = true;
    for (const t of toks) {
      let best = 0;
      for (const [f, w] of fields) {
        const i = f.indexOf(t);
        if (i >= 0) best = Math.max(best, w + (i === 0 ? 2 : (f[i - 1] === ' ' ? 1 : 0)));
      }
      if (!best) { ok = false; break; }
      total += best;
    }
    if (ok) scored.push([total, b]);
  }
  scored.sort((a, b) => b[0] - a[0] || natCompare(a[1].title, b[1].title));
  const cs = COLLECTIONS.filter((c) => toks.every((t) => norm(c.name).includes(t)));
  return { books: scored.map((x) => x[1]), collections: cs };
}

/* ---------------- mutation helpers ---------------- */
export async function setFavorite(id, on) { await db.patchBook(id, { favorite: on }); }
export async function markFinished(id) { await db.patchBook(id, { progress: 1, dateFinished: Date.now(), lastOpened: Date.now() }); }
export async function markUnread(id) { await db.patchBook(id, { progress: 0, dateFinished: 0, currentLocation: null, lastLabel: '' }); }
export async function editBook(id, { title, author, series, seriesNumber }) {
  const patch = { title: title.trim() || 'Untitled', author: (author || '').trim() };
  const s = (series || '').trim();
  patch.series = s;
  patch.seriesNumber = s && seriesNumber !== '' && seriesNumber != null && !isNaN(parseFloat(seriesNumber)) ? parseFloat(seriesNumber) : null;
  patch.seriesLocked = !s;                       // cleared by hand = "never group this one automatically"
  await db.patchBook(id, patch);
}
export async function removeBook(id) { revokeCover(id); await db.removeBook(id); }

/** Called by the reader (silent: no full library re-render for each page turn) */
export async function saveProgress(id, { location, progress, label }) {
  const b = byId(id);
  const patch = { currentLocation: location, progress, lastLabel: label || '', lastOpened: Date.now() };
  if (progress >= 0.985 && !(b && b.dateFinished)) patch.dateFinished = Date.now();
  const saved = await db.patchBook(id, patch, { silent: true });
  if (b && saved) Object.assign(b, saved);
}
export async function touchOpened(id) {
  const saved = await db.patchBook(id, { lastOpened: Date.now() }, { silent: true });
  const b = byId(id);
  if (b && saved) Object.assign(b, saved);
}

/* ---------------- covers ---------------- */
const coverUrls = new Map();
export async function coverUrl(id) {
  if (coverUrls.has(id)) return coverUrls.get(id);
  const p = db.getCover(id).then((blob) => {
    if (!blob) { coverUrls.delete(id); return null; }
    return URL.createObjectURL(blob);
  });
  coverUrls.set(id, p);
  return p;
}
export function revokeCover(id) {
  const p = coverUrls.get(id);
  coverUrls.delete(id);
  p?.then((u) => u && URL.revokeObjectURL(u));
}
let io;
function observer() {
  if (io) return io;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      io.unobserve(img);
      coverUrl(img.dataset.cover).then((u) => {
        if (!u) return;
        img.onload = () => img.classList.add('ready');
        img.src = u;
        if (img.complete) img.classList.add('ready');
      });
    }
  }, { rootMargin: '400px' });
  return io;
}
/** <img> that loads its cover when it scrolls into view */
export function coverImg(id, alt = '') {
  const img = document.createElement('img');
  img.alt = alt; img.decoding = 'async'; img.dataset.cover = id;
  observer().observe(img);
  return img;
}
export async function refreshCover(id) { revokeCover(id); bus.emit('library'); }
