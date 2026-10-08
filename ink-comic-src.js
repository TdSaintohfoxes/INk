/* INK — comic archive sources.
 *
 * A source exposes: { kind, names[], getBlob(i) -> Blob, info (ComicInfo|null), close() }
 * New archive formats (CB7, CBT…) only need a new entry in SOURCES below.
 *
 * .cbz is a ZIP; many ".cbr" files are really ZIPs too, so we always look at the
 * first bytes rather than trusting the extension. True RAR archives need the
 * libarchive add-on (loaded on demand; see openRar).
 */
import { openZip } from './ink-zip.js';
import { IMAGE_RE, parseComicInfo } from './ink-meta.js';
import { natCompare } from './ink-util.js';

export class ComicError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'comic'; }
}

const isPage = (name) => IMAGE_RE.test(name) && !/(^|\/)(__MACOSX|\.)/.test(name) && !/thumbs\.db$/i.test(name);

async function zipSource(blob) {
  const zip = await openZip(blob);
  const entries = zip.entries.filter((e) => !e.isDir && isPage(e.name));
  entries.sort((a, b) => natCompare(a.name, b.name));
  if (!entries.length) throw new ComicError('There are no images inside this archive.', 'empty');
  let info = null;
  const ci = zip.entries.find((e) => /(^|\/)comicinfo\.xml$/i.test(e.name));
  if (ci) { try { info = parseComicInfo(await zip.text(ci)); } catch { /* optional */ } }
  return {
    kind: 'zip', names: entries.map((e) => e.name), info,
    async getBlob(i) {
      const e = entries[i];
      const ext = (e.name.split('.').pop() || 'jpg').toLowerCase();
      return zip.blob(e, 'image/' + (ext === 'jpg' ? 'jpeg' : ext));
    },
    close() {},
  };
}

let rarLib = null;
async function loadRar() {
  if (rarLib) return rarLib;
  const tries = [
    () => import('./vendor-libarchive.js'),
    () => import('https://cdn.jsdelivr.net/npm/libarchive.js@2.0.2/dist/libarchive.js'),
  ];
  let last;
  for (const t of tries) {
    try {
      const mod = await t();
      const Archive = mod.Archive || mod.default?.Archive;
      if (!Archive) continue;
      // The worker must be same-origin; fetch it once and hand it over as a blob.
      let workerUrl = new URL('./vendor-libarchive-worker.js', import.meta.url).href;
      try {
        const r = await fetch(workerUrl);
        if (!r.ok) throw new Error('no local worker');
      } catch {
        const r = await fetch('https://cdn.jsdelivr.net/npm/libarchive.js@2.0.2/dist/worker-bundle.js');
        workerUrl = URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' }));
      }
      Archive.init({ workerUrl });
      rarLib = Archive;
      return rarLib;
    } catch (e) { last = e; }
  }
  throw new ComicError('This comic uses RAR compression, and INK’s RAR add-on could not be loaded. It is downloaded once and then works offline — connect to the internet and try again, or convert the file to CBZ.', 'rar-addon');
}

async function rarSource(blob) {
  const Archive = await loadRar();
  let arc;
  try { arc = await Archive.open(blob); }
  catch (e) { throw new ComicError('This RAR archive looks damaged or is password protected.', 'corrupt'); }
  const list = (await arc.getFilesArray()).filter((f) => isPage(f.path + f.file.name));
  list.sort((a, b) => natCompare(a.path + a.file.name, b.path + b.file.name));
  if (!list.length) throw new ComicError('There are no images inside this archive.', 'empty');
  return {
    kind: 'rar', names: list.map((f) => f.path + f.file.name), info: null,
    async getBlob(i) { return list[i].file.extract(); },
    close() { try { arc.close?.(); } catch { /* ignore */ } },
  };
}

/** Looks at the file header and returns the right source. */
export async function openComicSource(blob) {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const is = (...b) => b.every((v, i) => head[i] === v);
  if (is(0x50, 0x4b)) return zipSource(blob);                                  // PK
  if (is(0x52, 0x61, 0x72, 0x21)) return rarSource(blob);                      // Rar!
  if (is(0x37, 0x7a, 0xbc, 0xaf)) throw new ComicError('7-Zip comic archives (CB7) are not supported yet. Convert the file to CBZ.', 'unsupported');
  throw new ComicError('This file does not look like a comic archive.', 'corrupt');
}
