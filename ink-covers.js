/* INK — cover extraction and thumbnails.
 * Library covers are small JPEGs made once at import; we never render
 * full-size pages just to draw the shelf. */
import { hashHue } from './ink-util.js';
import { loadEpubPackage, resolvePath, dirname, mimeOf } from './ink-meta.js';

export const THUMB_W = 360;

/** Blob -> small JPEG blob */
export async function thumbFromBlob(blob, maxW = THUMB_W, quality = 0.84) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { resizeWidth: maxW, resizeQuality: 'medium' }); }
  catch {
    try {
      const full = await createImageBitmap(blob);
      const k = Math.min(1, maxW / full.width);
      const c = document.createElement('canvas');
      c.width = Math.round(full.width * k); c.height = Math.round(full.height * k);
      c.getContext('2d').drawImage(full, 0, 0, c.width, c.height);
      full.close?.();
      bmp = await createImageBitmap(c);
    } catch { bmp = null; }
  }
  if (!bmp) bmp = await viaImage(blob, maxW);
  return canvasToJpeg(bmp, quality);
}
function viaImage(blob, maxW) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxW / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(u);
      res(c);
    };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Image could not be decoded')); };
    img.src = u;
  });
}
function canvasToJpeg(src, quality) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0);
  src.close?.();
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', quality));
}

/** True when the canvas is essentially one flat colour (blank page) */
export function looksBlank(canvas) {
  const w = 48, h = Math.max(8, Math.round((48 * canvas.height) / canvas.width));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; if (v < min) min = v; if (v > max) max = v; }
  return max - min < 14;
}

/** EPUB: declared cover → cover page image → first picture of the first page */
export async function epubCover(zip, pkg) {
  pkg = pkg || await loadEpubPackage(zip);
  const tryImage = async (path) => {
    const e = path && zip.find(path);
    if (!e) return null;
    try { return await thumbFromBlob(await zip.blob(e, mimeOf(e.name))); } catch { return null; }
  };
  let b = await tryImage(pkg.coverHref);
  if (b) return b;
  const page = pkg.guideCover || (pkg.spine[0] && pkg.spine[0].href);
  const pe = page && zip.find(page);
  if (pe) {
    try {
      const doc = new DOMParser().parseFromString(await zip.text(pe), 'text/html');
      const el = doc.querySelector('img[src], image');
      const src = el && (el.getAttribute('src') || el.getAttribute('xlink:href') || el.getAttribute('href'));
      if (src && !/^data:/.test(src)) { b = await tryImage(resolvePath(dirname(pe.name), src)); if (b) return b; }
    } catch { /* ignore */ }
  }
  const any = zip.entries.find((e) => /cover.*\.(jpe?g|png|webp)$/i.test(e.name));
  return any ? tryImage(any.name) : null;
}

/** PDF: first page that is not blank */
export async function pdfCover(pdf) {
  const tries = Math.min(3, pdf.numPages);
  let last = null;
  for (let n = 1; n <= tries; n++) {
    const page = await pdf.getPage(n);
    const v0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: THUMB_W / v0.width });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup?.();
    last = c;
    if (!looksBlank(c)) break;
  }
  return last ? new Promise((res) => last.toBlob((b) => res(b), 'image/jpeg', 0.84)) : null;
}

/** Quiet typographic cover for books without artwork */
export function typographicCover(title, author, tag) {
  const W = THUMB_W, H = Math.round(THUMB_W * 1.5);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const hue = hashHue(title || 'x');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, `hsl(${hue} 22% 17%)`);
  g.addColorStop(1, `hsl(${(hue + 24) % 360} 26% 9%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = `hsl(${hue} 40% 62% / .5)`; ctx.lineWidth = 1.5;
  ctx.strokeRect(20, 20, W - 40, H - 40);
  ctx.fillStyle = '#efe9dc';
  ctx.textBaseline = 'alphabetic';
  const serif = 'Newsreader, "Iowan Old Style", Georgia, serif';
  let size = 34;
  let lines;
  const wrap = (txt, font, maxW) => {
    ctx.font = font;
    const out = []; let line = '';
    for (const w of String(txt).split(/\s+/)) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
    }
    if (line) out.push(line);
    return out;
  };
  for (; size >= 20; size -= 2) {
    lines = wrap(title || 'Untitled', `600 ${size}px ${serif}`, W - 76);
    if (lines.length <= 5) break;
  }
  lines = lines.slice(0, 6);
  let y = Math.round(H * 0.34);
  ctx.font = `600 ${size}px ${serif}`;
  for (const l of lines) { ctx.fillText(l, 38, y); y += size * 1.2; }
  if (author) {
    ctx.fillStyle = `hsl(${hue} 30% 72%)`;
    ctx.font = `400 17px ${serif}`;
    const al = wrap(author, `400 17px ${serif}`, W - 76).slice(0, 2);
    y += 14;
    for (const l of al) { ctx.fillText(l, 38, y); y += 22; }
  }
  ctx.fillStyle = `hsl(${hue} 20% 60% / .8)`;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillText(String(tag || '').toUpperCase().split('').join(' '), 38, H - 38);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.88));
}
