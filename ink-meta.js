/* INK — metadata helpers shared by import and the reading engines */

/* ---------------- filenames, titles, series ---------------- */
const JUNK = [
  /oceanofpdf\.com/gi, /pdfdrive(?:\.com)?/gi, /z-?lib(?:rary)?(?:\.(?:org|sk|rs|is))?/gi, /1lib(?:\.sk)?/gi,
  /libgen(?:\.(?:is|rs|li))?/gi, /\bwww\.[a-z0-9-]+\.[a-z]{2,}\b/gi,
];

export function cleanName(fileName) {
  let s = String(fileName || '').replace(/\.[a-z0-9]{2,4}$/i, '');
  for (const re of JUNK) s = s.replace(re, ' ');
  s = s.replace(/\((?:\s*[,.\s]*)\)|\[(?:\s*[,.\s]*)\]/g, ' ');
  s = s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–—.,]+|[\s\-–—.,]+$/g, '');
  return s || String(fileName || 'Untitled');
}

/** "Red Seas Under Red Skies - Scott Lynch" -> {title, author} (best guess; real metadata wins) */
export function guessTitleAuthor(clean) {
  const parts = clean.split(/\s+[-–—]\s+/);
  if (parts.length === 2) {
    const [a, b] = parts.map((x) => x.trim());
    const looksLikeNumber = /^(?:vol(?:ume)?\.?|v|issue|no\.?|book|part|ch(?:apter)?\.?|#)?\s*\d+/i.test(b);
    const words = b.split(/\s+/).length;
    if (a && b && !looksLikeNumber && !/\d/.test(b) && words <= 4) return { title: a, author: b };
  }
  return { title: clean, author: '' };
}

const SERIES_RE = /^(.+?)[\s._,:-]*[([]?(?:v(?:ol(?:ume)?)?\.?|book|bk\.?|part|pt\.?|no\.?|issue|#|ch(?:apter)?\.?)?[\s._-]*0*(\d{1,4})[)\]]?(?:\s*[([][^)\]]*[)\]])*$/i;

/** "Batman 001" -> {series:'Batman', number:1}. Only a suggestion – grouping needs 2+ matches. */
export function detectSeries(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  const m = SERIES_RE.exec(t);
  if (!m) return null;
  let series = m[1].replace(/[\s._,:-]+$/g, '').replace(/\s+(?:vol(?:ume)?|v|book|bk|part|pt|no|issue|ch(?:apter)?)\.?$/i, '').trim();
  const number = parseInt(m[2], 10);
  if (!series || series.length < 2 || /^\d+$/.test(series)) return null;
  if (/^(?:19|20)\d{2}$/.test(String(m[2])) && !/\b(?:vol|v|issue|book|no|#)/i.test(t)) return null; // a year, not a volume
  return { series, number };
}
export const seriesKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

/* ---------------- path helpers ---------------- */
export const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
export function resolvePath(dir, href) {
  href = String(href || '').split('#')[0].split('?')[0];
  try { href = decodeURIComponent(href); } catch { /* keep raw */ }
  const parts = (href.charAt(0) === '/' ? href.slice(1) : (dir ? dir + '/' : '') + href).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}
export const fragmentOf = (href) => { const i = String(href || '').indexOf('#'); if (i < 0) return ''; try { return decodeURIComponent(href.slice(i + 1)); } catch { return href.slice(i + 1); } };

export function mimeOf(path) {
  const e = (path.split('.').pop() || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    css: 'text/css', xhtml: 'application/xhtml+xml', html: 'text/html', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' }[e] || 'application/octet-stream';
}
export const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

/* ---------------- XML ---------------- */
export function parseXML(text) {
  return new DOMParser().parseFromString(String(text).replace(/^﻿/, ''), 'application/xml');
}
const ns = (el, name) => [...el.getElementsByTagNameNS('*', name)];
const text1 = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/* ---------------- EPUB package ---------------- */
/** Reads container.xml + the OPF. Never throws on odd books; returns what it can. */
export async function loadEpubPackage(zip) {
  const pkg = { opfPath: '', base: '', title: '', authors: [], language: '', series: '', seriesIndex: null, manifest: {}, spine: [], coverHref: '', navHref: '', ncxHref: '', rtl: false, description: '', version: 2 };
  let opfPath = '';
  try {
    const cx = parseXML(await zip.text('META-INF/container.xml'));
    opfPath = ns(cx, 'rootfile')[0]?.getAttribute('full-path') || '';
  } catch { /* handled below */ }
  if (!opfPath) opfPath = zip.entries.find((e) => /\.opf$/i.test(e.name))?.name || '';
  if (!opfPath) throw new Error('This EPUB has no package file (content.opf).');
  pkg.opfPath = opfPath;
  pkg.base = dirname(opfPath);
  const opf = parseXML(await zip.text(opfPath));
  if (opf.getElementsByTagName('parsererror').length && !ns(opf, 'manifest').length) throw new Error('The EPUB package file is damaged.');

  const root = opf.documentElement;
  pkg.version = parseFloat(root.getAttribute('version')) || 2;
  const md = ns(root, 'metadata')[0];
  if (md) {
    pkg.title = text1(ns(md, 'title')[0]);
    pkg.authors = ns(md, 'creator').map(text1).filter(Boolean);
    pkg.language = text1(ns(md, 'language')[0]);
    pkg.description = text1(ns(md, 'description')[0]).slice(0, 600);
    const metas = ns(md, 'meta');
    for (const m of metas) {
      const name = m.getAttribute('name');
      if (name === 'calibre:series') pkg.series = m.getAttribute('content') || '';
      if (name === 'calibre:series_index') pkg.seriesIndex = parseFloat(m.getAttribute('content')) || null;
    }
    const coll = metas.find((m) => m.getAttribute('property') === 'belongs-to-collection');
    if (coll && !pkg.series) {
      pkg.series = text1(coll);
      const id = coll.getAttribute('id');
      const pos = metas.find((m) => m.getAttribute('refines') === '#' + id && m.getAttribute('property') === 'group-position');
      if (pos) pkg.seriesIndex = parseFloat(text1(pos)) || null;
    }
  }
  const metaCover = md ? ns(md, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content') : '';
  for (const it of ns(root, 'item')) {
    const id = it.getAttribute('id');
    const href = resolvePath(pkg.base, it.getAttribute('href') || '');
    pkg.manifest[id] = { id, href, type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
    if (/\bnav\b/.test(pkg.manifest[id].props)) pkg.navHref = href;
    if (/\bcover-image\b/.test(pkg.manifest[id].props)) pkg.coverHref = href;
  }
  const spineEl = ns(root, 'spine')[0];
  if (spineEl) {
    pkg.rtl = spineEl.getAttribute('page-progression-direction') === 'rtl';
    const tocId = spineEl.getAttribute('toc');
    if (tocId && pkg.manifest[tocId]) pkg.ncxHref = pkg.manifest[tocId].href;
    for (const ir of ns(spineEl, 'itemref')) {
      const m = pkg.manifest[ir.getAttribute('idref')];
      if (m && ir.getAttribute('linear') !== 'no') pkg.spine.push(m);
    }
  }
  if (!pkg.ncxHref) pkg.ncxHref = Object.values(pkg.manifest).find((m) => /ncx/.test(m.type))?.href || '';
  if (!pkg.coverHref && metaCover && pkg.manifest[metaCover]) pkg.coverHref = pkg.manifest[metaCover].href;
  if (!pkg.coverHref) {
    const guide = ns(root, 'reference').find((r) => r.getAttribute('type') === 'cover');
    if (guide) pkg.guideCover = resolvePath(pkg.base, guide.getAttribute('href') || '');
  }
  if (!pkg.coverHref) {
    const byName = Object.values(pkg.manifest).find((m) => /^image\//.test(m.type) && /cover/i.test(m.id + ' ' + m.href));
    if (byName) pkg.coverHref = byName.href;
  }
  if (!pkg.spine.length) {
    pkg.spine = zip.entries.filter((e) => /\.(xhtml|html|htm)$/i.test(e.name) && !e.isDir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((e) => ({ id: e.name, href: e.name, type: 'application/xhtml+xml', props: '' }));
  }
  return pkg;
}

/** Table of contents: EPUB3 nav first, then NCX. Items: {label, href(path#frag), level} */
export async function loadEpubToc(zip, pkg) {
  const items = [];
  try {
    if (pkg.navHref && zip.has(pkg.navHref)) {
      const doc = new DOMParser().parseFromString(await zip.text(pkg.navHref), 'text/html');
      const navs = [...doc.querySelectorAll('nav')];
      const nav = navs.find((n) => /\btoc\b/.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || navs[0];
      const base = dirname(pkg.navHref);
      const walk = (ol, level) => {
        for (const li of ol.children) {
          if (li.tagName !== 'LI') continue;
          const a = li.querySelector(':scope > a, :scope > span');
          const sub = li.querySelector(':scope > ol');
          const href = a?.getAttribute?.('href');
          if (a) items.push({ label: text1(a), href: href ? resolvePath(base, href) + (href.includes('#') ? '#' + fragmentOf(href) : '') : '', level });
          if (sub) walk(sub, level + 1);
        }
      };
      const ol = nav?.querySelector('ol');
      if (ol) walk(ol, 0);
    }
  } catch { /* try NCX */ }
  if (!items.length && pkg.ncxHref && zip.has(pkg.ncxHref)) {
    try {
      const doc = parseXML(await zip.text(pkg.ncxHref));
      const base = dirname(pkg.ncxHref);
      const walk = (parent, level) => {
        for (const np of [...parent.children].filter((c) => c.localName === 'navPoint')) {
          const label = text1(ns(np, 'text')[0]);
          const src = ns(np, 'content')[0]?.getAttribute('src') || '';
          items.push({ label, href: src ? resolvePath(base, src) + (src.includes('#') ? '#' + fragmentOf(src) : '') : '', level });
          walk(np, level + 1);
        }
      };
      const map = ns(doc.documentElement, 'navMap')[0];
      if (map) walk(map, 0);
    } catch { /* no toc */ }
  }
  return items.filter((i) => i.label);
}

/* ---------------- ComicInfo.xml ---------------- */
export function parseComicInfo(xmlText) {
  try {
    const doc = parseXML(xmlText);
    const g = (n) => text1(doc.getElementsByTagName(n)[0]);
    return {
      title: g('Title'), series: g('Series'), number: parseFloat(g('Number')) || null, volume: g('Volume'),
      author: [g('Writer'), g('Penciller')].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '),
      manga: /righttoleft/i.test(g('Manga')), summary: g('Summary').slice(0, 600),
    };
  } catch { return null; }
}

/** Number-ish display for a series position */
export const fmtNumber = (n) => (n == null ? '' : Number.isInteger(n) ? String(n).padStart(2, '0') : String(n));
