/* INK — import pipeline.
 * detect format → read metadata → make cover → keep the original → add to library.
 * Never throws for one bad file: every file ends as added / duplicate / failed. */
import * as db from './ink-db.js';
import { uid, withTimeout, bus } from './ink-util.js';
import { openZip } from './ink-zip.js';
import { cleanName, guessTitleAuthor, detectSeries, loadEpubPackage } from './ink-meta.js';
import { epubCover, pdfCover, typographicCover, thumbFromBlob } from './ink-covers.js';

export const ACCEPT = '.epub,.pdf,.cbz,.cbr,application/epub+zip,application/pdf,application/vnd.comicbook+zip,application/vnd.comicbook-rar,application/x-cbz,application/x-cbr';
export const EXT_RE = /\.(epub|pdf|cbz|cbr)$/i;

export const FORMAT_LABEL = { epub: 'EPUB', pdf: 'PDF', comic: 'Comic' };

/** Decide what a file really is by looking at its first bytes (extension is only a hint). */
export async function sniffFormat(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const ascii = new TextDecoder('latin1').decode(head);
  if (ascii.includes('%PDF-')) return { format: 'pdf', ext: 'pdf' };
  const zip = head[0] === 0x50 && head[1] === 0x4b;
  if (zip) {
    if (ext === 'epub') return { format: 'epub', ext: 'epub' };
    if (ext === 'cbz' || ext === 'cbr' || ext === 'zip') return { format: 'comic', ext: ext === 'cbr' ? 'cbr' : 'cbz' };
    try { // unknown extension: peek inside
      const z = await openZip(file);
      if (z.has('META-INF/container.xml')) return { format: 'epub', ext: 'epub' };
      if (z.entries.some((e) => /\.(jpe?g|png|webp|gif)$/i.test(e.name))) return { format: 'comic', ext: 'cbz' };
    } catch { /* fall through */ }
  }
  if (ascii.startsWith('Rar!')) return { format: 'comic', ext: 'cbr' };
  if (ext === 'pdf') return { format: 'pdf', ext };
  if (ext === 'epub') return { format: 'epub', ext };
  if (ext === 'cbz' || ext === 'cbr') return { format: 'comic', ext };
  return null;
}

async function readEpub(file) {
  const zip = await openZip(file);
  const pkg = await loadEpubPackage(zip);
  let cover = null;
  try { cover = await epubCover(zip, pkg); } catch { /* generated later */ }
  return {
    cover,
    title: pkg.title, author: pkg.authors.slice(0, 3).join(', '),
    series: pkg.series, seriesNumber: pkg.seriesIndex,
    meta: { pages: pkg.spine.length, language: pkg.language, description: pkg.description, rtl: pkg.rtl, epubVersion: pkg.version },
  };
}

async function readPdf(file) {
  const { openPdf, isPasswordError } = await import('./ink-pdfjs.js');
  let pdf;
  try { pdf = await openPdf(file); }
  catch (e) {
    if (isPasswordError(e)) return { cover: null, title: '', author: '', meta: { encrypted: true } };
    throw e;
  }
  try {
    let info = {};
    try { info = (await pdf.getMetadata()).info || {}; } catch { /* optional */ }
    let cover = null;
    try { cover = await pdfCover(pdf); } catch { /* generated later */ }
    return { cover, title: (info.Title || '').trim(), author: (info.Author || '').trim(), meta: { pages: pdf.numPages } };
  } finally { try { await pdf.destroy(); } catch { /* ignore */ } }
}

async function readComic(file) {
  const { openComicSource } = await import('./ink-comic-src.js');
  const src = await openComicSource(file);
  try {
    let cover = null;
    try { cover = await thumbFromBlob(await src.getBlob(0)); } catch { /* generated later */ }
    const i = src.info || {};
    return {
      cover, title: i.title || '', author: i.author || '', series: i.series || '', seriesNumber: i.number || null,
      meta: { pages: src.names.length, rtl: !!i.manga, description: i.summary || '' },
    };
  } finally { src.close(); }
}

/** Import one File. Returns {status:'added'|'duplicate'|'failed', book?, error?} */
export async function importFile(file, existing = []) {
  try {
    const kind = await sniffFormat(file);
    if (!kind) return { status: 'failed', error: 'Unsupported file type (INK reads EPUB, PDF, CBZ and CBR).', name: file.name };
    const dup = existing.find((b) => b.fileName === file.name && b.size === file.size);
    if (dup) return { status: 'duplicate', book: dup, name: file.name };

    let info;
    try {
      info = await withTimeout(kind.format === 'epub' ? readEpub(file) : kind.format === 'pdf' ? readPdf(file) : readComic(file), 90000, 'Reading this file took too long.');
    } catch (e) {
      return { status: 'failed', error: friendlyReason(e, kind.format), name: file.name };
    }

    const clean = cleanName(file.name);
    const guess = guessTitleAuthor(clean);
    const junkTitle = (t) => !t || t.length < 2 || /^(untitled|unknown|anonymous|unspecified|title|document\d*)$/i.test(t) || /^microsoft (word|powerpoint|excel) - /i.test(t) || /\.(docx?|pptx?|indd|tex|pdf|rtf|odt)$/i.test(t);
    const junkAuthor = (a) => !a || /^(anonymous|unknown|unspecified|author|admin|user|owner)$/i.test(a);
    const title = (!junkTitle(info.title) ? info.title : guess.title).trim();
    const author = (!junkAuthor(info.author) ? info.author : guess.author || '').trim();
    const auto = detectSeries(title) || detectSeries(clean);
    const id = uid();
    const book = {
      id, title, author,
      series: info.series || '', seriesNumber: info.seriesNumber ?? null, seriesLocked: false,
      format: kind.format, ext: kind.ext, fileName: file.name, size: file.size,
      hasCover: false, progress: 0, currentLocation: null,
      dateAdded: Date.now(), lastOpened: 0, dateFinished: 0, favorite: false,
      meta: { ...(info.meta || {}), seriesAuto: auto || null },
    };

    let coverBlob = info.cover;
    if (!coverBlob) coverBlob = await typographicCover(title, author, kind.format === 'comic' ? kind.ext : kind.format);
    else book.meta.realCover = true;

    await db.putFile(id, new Blob([file], { type: file.type || mimeFor(kind) }));   // original, untouched
    if (coverBlob) { await db.putCover(id, coverBlob); book.hasCover = true; }
    await db.saveBook(book);
    return { status: 'added', book };
  } catch (e) {
    console.error('import failed', file.name, e);
    return { status: 'failed', error: friendlyReason(e), name: file.name };
  }
}

const mimeFor = (k) => (k.format === 'pdf' ? 'application/pdf' : k.format === 'epub' ? 'application/epub+zip' : k.ext === 'cbr' ? 'application/vnd.comicbook-rar' : 'application/vnd.comicbook+zip');

export function friendlyReason(e, format) {
  const m = String(e?.message || e || '');
  if (e?.code === 'rar-addon' || e?.code === 'unsupported' || e?.code === 'empty') return m;
  if (e?.code === 'encrypted') return 'This archive is password protected.';
  if (/password/i.test(m) || e?.name === 'PasswordException') return 'This file is password protected.';
  if (e?.code === 'corrupt' || /invalid|corrupt|damaged|not a valid|end of|central directory/i.test(m)) return 'The file looks damaged or incomplete. Try downloading or exporting it again.';
  if (/quota/i.test(m) || e?.name === 'QuotaExceededError') return 'Not enough storage space on this device.';
  return m || 'The file could not be read.';
}

/** Import a list of Files one by one. onStatus({i,n,name,result}) after each. */
export async function importFiles(files, onStatus) {
  const list = [...files].filter((f) => f && f.name);
  const existing = await db.listBooks();
  const out = { added: [], duplicate: [], failed: [] };
  db.requestPersistence();
  for (let i = 0; i < list.length; i++) {
    onStatus?.({ i, n: list.length, name: list[i].name, phase: 'start' });
    const r = await importFile(list[i], existing);
    if (r.status === 'added') existing.push(r.book);
    out[r.status].push(r);
    onStatus?.({ i, n: list.length, name: list[i].name, phase: 'done', result: r });
    await new Promise((res) => setTimeout(res, 0));
  }
  if (out.added.length) bus.emit('imported', out.added.map((r) => r.book));
  return out;
}

/** Folder pick (webkitdirectory): keep only readable books, in natural order */
export function filesFromFolder(fileList) {
  return [...fileList].filter((f) => EXT_RE.test(f.name))
    .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
}

/** Bring over books from the previous Folio library (non-destructive). */
export async function migrateLegacy(onStatus) {
  const items = await db.readLegacy();
  if (!items.length) { await db.markLegacyDone(); return { added: 0 }; }
  const files = [];
  for (const { meta, blob } of items) {
    const fmt = String(meta.format || '').toLowerCase();
    if (!['epub', 'pdf', 'cbz', 'cbr'].includes(fmt)) continue;
    const name = (meta.title || 'Untitled') + '.' + fmt;
    files.push(new File([blob], name, { type: blob.type }));
  }
  const res = await importFiles(files, onStatus);
  await db.markLegacyDone();
  return { added: res.added.length, failed: res.failed.length };
}
