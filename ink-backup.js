/* INK — backup, restore and library-wide highlight export. Everything stays on the device: the backup is a plain ZIP you keep. */
import * as db from './ink-db.js';
import { openZip } from './ink-zip.js';

const enc = new TextEncoder();
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8, crc = 0) { crc = ~crc >>> 0; for (let i = 0; i < u8.length; i++) crc = CRC[(crc ^ u8[i]) & 255] ^ (crc >>> 8); return ~crc >>> 0; }

/** Minimal ZIP writer (stored, no compression — books are already compressed). Entries are Blobs or strings; blobs are never held in memory together. */
async function buildZip(entries, onProgress) {
  const parts = [], central = [];
  let offset = 0, i = 0;
  const dos = (d = new Date()) => ({ t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), d: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
  const { t: dt, d: dd } = dos();
  for (const [name, data] of entries) {
    const blob = typeof data === 'string' ? new Blob([data]) : data;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(bytes), nm = enc.encode(name);
    if (blob.size >= 0xffffffff || offset >= 0xffffffff) throw new Error('This library is too large for a single backup file. Back up your data without books instead.');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true); lh.setUint32(18, blob.size, true); lh.setUint32(22, blob.size, true);
    lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nm, blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true); ch.setUint32(20, blob.size, true); ch.setUint32(24, blob.size, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, nm);
    offset += 30 + nm.length + blob.size;
    onProgress?.(++i / entries.length);
  }
  const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

const STORES = ['books', 'collections', 'collectionBooks', 'bookmarks', 'highlights', 'sessions'];
const KV_KEYS = ['settings', 'dictpack', 'dictcache'];

export async function estimate() {
  const books = await db.listBooks();
  return { books: books.length, bytes: books.reduce((n, b) => n + (b.size || 0), 0) };
}

/** includeBooks=false → small data-only backup (progress, highlights, bookmarks, collections, stats, settings). */
export async function createBackup({ includeBooks = true, onProgress } = {}) {
  const data = { app: 'INK', version: 1, created: new Date().toISOString(), includesBooks: !!includeBooks, kv: {} };
  for (const s of STORES) data[s] = await db.all(s);
  for (const k of KV_KEYS) { const v = await db.kvGet(k, undefined); if (v !== undefined) data.kv[k] = v; }
  const entries = [['data.json', JSON.stringify(data)]];
  if (includeBooks) {
    for (const b of data.books) {
      const f = await db.getFile(b.id); if (f) entries.push([`files/${b.id}`, f]);
      const c = await db.getCover(b.id); if (c) entries.push([`covers/${b.id}`, c]);
    }
  }
  const blob = await buildZip(entries, onProgress);
  const stamp = new Date().toISOString().slice(0, 10);
  return { blob, name: `INK-backup-${stamp}${includeBooks ? '' : '-data-only'}.zip`, counts: { books: data.books.length, highlights: data.highlights.length, bookmarks: data.bookmarks.length } };
}

const fp = (b) => `${(b.fileName || b.title || '').toLowerCase()}|${b.size || 0}`;

/** Merges a backup into this device. Existing items are kept; nothing is deleted. */
export async function restoreBackup(file, { onProgress } = {}) {
  let zip;
  try { zip = await openZip(file); } catch { throw new Error('That file isn’t an INK backup.'); }
  const entry = zip.find('data.json');
  if (!entry) throw new Error('That file isn’t an INK backup.');
  const data = JSON.parse(await zip.text(entry));
  if (data.app !== 'INK') throw new Error('That file isn’t an INK backup.');

  const have = await db.listBooks();
  const byId = new Map(have.map((b) => [b.id, b])), byFp = new Map(have.map((b) => [fp(b), b]));
  const idMap = new Map();     // backup id → local id
  const stats = { booksAdded: 0, booksMatched: 0, highlights: 0, bookmarks: 0, sessions: 0, collections: 0, skippedNoFile: 0 };
  let step = 0; const steps = data.books.length + 6;
  for (const b of data.books) {
    let local = byId.get(b.id) || byFp.get(fp(b));
    if (local) {
      idMap.set(b.id, local.id); stats.booksMatched++;
      if ((b.dateModified || 0) > (local.dateModified || 0) && (b.progress || 0) >= (local.progress || 0)) {
        await db.patchBook(local.id, { progress: b.progress, currentLocation: b.currentLocation, lastLabel: b.lastLabel, lastOpened: b.lastOpened, dateFinished: b.dateFinished, favorite: b.favorite, readingPrefs: b.readingPrefs }, { silent: true });
      }
    } else if (data.includesBooks && zip.has(`files/${b.id}`)) {
      await db.put('books', b);
      await db.putFile(b.id, await zip.blob(`files/${b.id}`, ''));
      if (zip.has(`covers/${b.id}`)) await db.putCover(b.id, await zip.blob(`covers/${b.id}`, 'image/jpeg'));
      idMap.set(b.id, b.id); stats.booksAdded++;
    } else stats.skippedNoFile++;
    onProgress?.(++step / steps);
  }
  const m = (id) => idMap.get(id);
  const existing = async (store) => new Set((await db.all(store)).map((x) => x.id ?? x.key));
  const [hSet, bSet, cSet, lSet] = await Promise.all([existing('highlights'), existing('bookmarks'), existing('collections'), existing('collectionBooks')]);
  for (const x of data.highlights || []) if (m(x.bookId) && !hSet.has(x.id)) { await db.put('highlights', { ...x, bookId: m(x.bookId) }); stats.highlights++; }
  onProgress?.(++step / steps);
  for (const x of data.bookmarks || []) if (m(x.bookId) && !bSet.has(x.id)) { await db.put('bookmarks', { ...x, bookId: m(x.bookId) }); stats.bookmarks++; }
  onProgress?.(++step / steps);
  for (const x of data.collections || []) if (!cSet.has(x.id)) { await db.put('collections', x); stats.collections++; }
  for (const x of data.collectionBooks || []) if (m(x.bookId)) { const key = `${x.collectionId}:${m(x.bookId)}`; if (!lSet.has(x.key) && !lSet.has(key)) await db.put('collectionBooks', { ...x, key, bookId: m(x.bookId) }); }
  onProgress?.(++step / steps);
  // reading time: keep the larger value per day+book
  const cur = new Map((await db.all('sessions')).map((s) => [s.id, s]));
  for (const x of data.sessions || []) {
    const bid = m(x.bookId); if (!bid) continue;
    const id = `${x.day}:${bid}`, c = cur.get(id);
    if (!c || c.seconds < x.seconds) { await db.put('sessions', { ...x, id, bookId: bid }); stats.sessions++; }
  }
  onProgress?.(++step / steps);
  // settings + dictionary (only when this device has none)
  const kv = data.kv || {};
  if (kv.settings && !(await db.kvGet('settings', null))) await db.kvSet('settings', kv.settings);
  if (kv.dictpack && !Object.keys(await db.kvGet('dictpack', {})).length) await db.kvSet('dictpack', kv.dictpack);
  if (kv.dictcache) await db.kvSet('dictcache', { ...kv.dictcache, ...(await db.kvGet('dictcache', {})) });
  onProgress?.(1);
  return stats;
}

/** Markdown of every highlight and bookmark, grouped by book then chapter. */
export async function exportAllAnnotations() {
  const [books, hls, bms] = await Promise.all([db.listBooks(), db.allHighlights(), db.allBookmarks()]);
  const title = (id) => books.find((b) => b.id === id);
  const ids = [...new Set([...hls, ...bms].map((x) => x.bookId))].filter((id) => title(id));
  if (!ids.length) return null;
  let md = `# INK — highlights & notes\n\n*Exported ${new Date().toLocaleDateString()}*\n\n`;
  for (const id of ids.sort((a, b) => (title(a).title || '').localeCompare(title(b).title || ''))) {
    const b = title(id);
    md += `## ${b.title}\n${b.author ? `*${b.author}*\n` : ''}\n`;
    const hs = hls.filter((x) => x.bookId === id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const byLabel = new Map();
    for (const x of hs) { const k = x.label || 'Highlights'; if (!byLabel.has(k)) byLabel.set(k, []); byLabel.get(k).push(x); }
    for (const [label, list] of byLabel) {
      md += `### ${label}\n\n`;
      for (const x of list) md += `> ${(x.text || x.selectedText || '').replace(/\n+/g, ' ')}\n${x.note ? `\n**Note:** ${x.note}\n` : ''}\n`;
    }
    const bs = bms.filter((x) => x.bookId === id);
    if (bs.length) md += `### Bookmarks\n\n${bs.map((m) => `- ${m.title || 'Bookmark'}${m.note ? ` — ${m.note}` : ''}`).join('\n')}\n\n`;
  }
  return new Blob([md], { type: 'text/markdown' });
}

export function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
