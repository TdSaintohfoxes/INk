/* INK — local database (IndexedDB). Same schema serves EPUB, PDF and comics.
 *
 *  books            Book {id,title,author,series,seriesNumber,format,fileName,size,hasCover,progress,
 *                         currentLocation,dateAdded,lastOpened,dateFinished,dateModified,favorite,meta}
 *  files            {id, blob}         the untouched original
 *  covers           {id, blob}         small thumbnail
 *  collections      {id, name, createdAt}
 *  collectionBooks  {key, collectionId, bookId}   (links only – files are never duplicated)
 *  bookmarks        {id, bookId, location, title, createdAt}
 *  highlights       {id, bookId, location, selectedText, color, note, createdAt}
 *  sessions         {id:'day:bookId', day, bookId, seconds, pages}
 *  kv               {key, value}
 */
import { uid, bus } from './ink-util.js';

const NAME = 'ink-v1';
let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('files', { keyPath: 'id' });
      d.createObjectStore('covers', { keyPath: 'id' });
      d.createObjectStore('collections', { keyPath: 'id' });
      const cb = d.createObjectStore('collectionBooks', { keyPath: 'key' });
      cb.createIndex('collectionId', 'collectionId');
      cb.createIndex('bookId', 'bookId');
      d.createObjectStore('bookmarks', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      d.createObjectStore('highlights', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      d.createObjectStore('sessions', { keyPath: 'id' }).createIndex('day', 'day');
      d.createObjectStore('kv', { keyPath: 'key' });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => { d.close(); dbp = null; };
      resolve(d);
    };
    r.onerror = () => { dbp = null; reject(r.error); };
    r.onblocked = () => { /* another tab holds an old connection */ };
  });
  return dbp;
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const finish = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
});

export async function get(store, key) { const d = await openDB(); return wrap(d.transaction(store).objectStore(store).get(key)); }
export async function all(store) { const d = await openDB(); return wrap(d.transaction(store).objectStore(store).getAll()); }
export async function byIndex(store, index, key) { const d = await openDB(); return wrap(d.transaction(store).objectStore(store).index(index).getAll(key)); }
export async function put(store, val) { const d = await openDB(); const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(val); return finish(tx); }
export async function del(store, key) { const d = await openDB(); const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); return finish(tx); }
export async function clearStore(store) { const d = await openDB(); const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).clear(); return finish(tx); }

/* ---------------- books ---------------- */
export const listBooks = () => all('books');
export const getBook = (id) => get('books', id);
export async function saveBook(book) { book.dateModified = Date.now(); await put('books', book); bus.emit('books'); return book; }
export async function patchBook(id, patch, { silent = false } = {}) {
  const b = await getBook(id);
  if (!b) return null;
  Object.assign(b, patch);
  b.dateModified = Date.now();
  await put('books', b);
  if (!silent) bus.emit('books');
  return b;
}
export const getFile = async (id) => (await get('files', id))?.blob || null;
export const putFile = (id, blob) => put('files', { id, blob });
export const getCover = async (id) => (await get('covers', id))?.blob || null;
export const putCover = (id, blob) => put('covers', { id, blob });

export async function removeBook(id) {
  const d = await openDB();
  const [bms, hls, links] = await Promise.all([byIndex('bookmarks', 'bookId', id), byIndex('highlights', 'bookId', id), byIndex('collectionBooks', 'bookId', id)]);
  const tx = d.transaction(['books', 'files', 'covers', 'bookmarks', 'highlights', 'collectionBooks'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('files').delete(id);
  tx.objectStore('covers').delete(id);
  bms.forEach((x) => tx.objectStore('bookmarks').delete(x.id));
  hls.forEach((x) => tx.objectStore('highlights').delete(x.id));
  links.forEach((x) => tx.objectStore('collectionBooks').delete(x.key));
  await finish(tx);
  bus.emit('books');
}

/* ---------------- collections ---------------- */
export const listCollections = async () => (await all('collections')).sort((a, b) => a.createdAt - b.createdAt);
export async function createCollection(name) {
  const c = { id: uid(), name: name.trim(), createdAt: Date.now() };
  await put('collections', c);
  bus.emit('collections');
  return c;
}
export async function renameCollection(id, name) {
  const c = await get('collections', id);
  if (!c) return;
  c.name = name.trim();
  await put('collections', c);
  bus.emit('collections');
}
export async function deleteCollection(id) {
  const d = await openDB();
  const links = await byIndex('collectionBooks', 'collectionId', id);
  const tx = d.transaction(['collections', 'collectionBooks'], 'readwrite');
  tx.objectStore('collections').delete(id);
  links.forEach((l) => tx.objectStore('collectionBooks').delete(l.key));
  await finish(tx);
  bus.emit('collections');
}
export async function collectionBookIds(cid) { return (await byIndex('collectionBooks', 'collectionId', cid)).map((l) => l.bookId); }
export async function bookCollectionIds(bid) { return (await byIndex('collectionBooks', 'bookId', bid)).map((l) => l.collectionId); }
export async function allLinks() { return all('collectionBooks'); }
export async function setMembership(cid, bid, on) {
  const key = cid + ':' + bid;
  if (on) await put('collectionBooks', { key, collectionId: cid, bookId: bid });
  else await del('collectionBooks', key);
  bus.emit('collections');
}

/* ---------------- bookmarks / highlights ---------------- */
export const listBookmarks = async (bookId) => (await byIndex('bookmarks', 'bookId', bookId)).sort((a, b) => a.createdAt - b.createdAt);
export async function addBookmark(bookId, location, title) {
  const b = { id: uid(), bookId, location, title, createdAt: Date.now() };
  await put('bookmarks', b);
  return b;
}
export const deleteBookmark = (id) => del('bookmarks', id);
export const listHighlights = async (bookId) => (await byIndex('highlights', 'bookId', bookId)).sort((a, b) => a.createdAt - b.createdAt);
export async function saveHighlight(h) {
  if (!h.id) h.id = uid();
  if (!h.createdAt) h.createdAt = Date.now();
  await put('highlights', h);
  return h;
}
export const deleteHighlight = (id) => del('highlights', id);
export const allHighlights = () => all('highlights');
export const allBookmarks = () => all('bookmarks');

/* ---------------- sessions (reading stats) ---------------- */
export async function addSession(bookId, day, seconds, pages) {
  const id = day + ':' + bookId;
  const cur = (await get('sessions', id)) || { id, day, bookId, seconds: 0, pages: 0 };
  cur.seconds += seconds;
  cur.pages += pages;
  await put('sessions', cur);
}
export const allSessions = () => all('sessions');

/* ---------------- kv ---------------- */
export async function kvGet(key, fallback) { const r = await get('kv', key); return r ? r.value : fallback; }
export const kvSet = (key, value) => put('kv', { key, value });

/* ---------------- storage ---------------- */
export async function storageInfo() {
  const out = { usage: 0, quota: 0, persisted: false };
  try {
    const e = await navigator.storage.estimate();
    out.usage = e.usage || 0; out.quota = e.quota || 0;
    out.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  } catch { /* not available */ }
  return out;
}
export async function requestPersistence() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

/* ---------------- legacy library (Folio v3) ----------------
 * Reads books saved by the previous version and hands them to `importLegacy`.
 * The old database is left untouched. */
export async function readLegacy() {
  if (await kvGet('legacyMigrated', false)) return [];
  const out = await new Promise((resolve) => {
    let created = false;
    let r;
    try { r = indexedDB.open('folio-v3'); } catch { return resolve([]); }
    r.onupgradeneeded = () => { created = true; r.transaction.abort(); };
    r.onerror = () => resolve([]);
    r.onsuccess = async () => {
      const d = r.result;
      try {
        if (created || !d.objectStoreNames.contains('books') || !d.objectStoreNames.contains('blobs')) { d.close(); return resolve([]); }
        const tx = d.transaction(['books', 'blobs']);
        const books = await wrap(tx.objectStore('books').getAll());
        const items = [];
        for (const b of books) {
          const rec = await wrap(tx.objectStore('blobs').get(b.id));
          if (rec?.blob) items.push({ meta: b, blob: rec.blob });
        }
        d.close();
        resolve(items);
      } catch { try { d.close(); } catch { /* ignore */ } resolve([]); }
    };
  });
  return out;
}
export const markLegacyDone = () => kvSet('legacyMigrated', true);
