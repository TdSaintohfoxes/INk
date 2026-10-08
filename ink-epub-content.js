/* INK — EPUB content: turn a spine document into safe, themeable, splittable DOM.
 *
 *  loadSection()  parse (XHTML first, HTML fallback) → sanitise → keep only the book's semantic styling
 *                 (italic, centred, small…) scoped to the section → split very long chapters into parts
 *  Offsets        every location inside a section is a character offset into its text, so highlights,
 *                 bookmarks, search hits and resume positions survive font / size / margin changes.
 */
import { dirname, resolvePath } from './ink-meta.js';

export const PART_LIMIT = 60000;   // characters per part (≈ 30–35 pages)
const DROP = 'script,style,link,meta,title,iframe,object,embed,form,input,button,select,textarea,noscript,base,template,audio,video,source,track,canvas';
const GENERIC = new Set(['div', 'section', 'article', 'main', 'span', 'body']);

/* ---------------- parsing ---------------- */
export function parseHtml(text) {
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.body) doc = null;
  } catch { doc = null; }
  if (!doc) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}

/* ---------------- author CSS: keep meaning, drop layout ---------------- */
const KEEP_PROP = /^(font-style|font-weight|text-align|text-align-last|text-indent|text-decoration-line|text-transform|font-variant-caps|vertical-align|white-space|font-size|display)$/;
function okValue(p, v) {
  v = String(v).trim();
  if (!v || /url\(|expression|!important\s*!/i.test(v)) return false;
  if (p === 'display') return /^none$/i.test(v);
  if (p === 'font-size') return /^[\d.]+(em|%)$/.test(v) || /^(x-small|small|smaller|large|larger|x-large|xx-large)$/i.test(v);
  if (p === 'text-indent') return /^(0|-?[\d.]+(em|%))$/.test(v);
  if (p === 'vertical-align') return /^(super|sub|baseline|top|middle|bottom|text-top|text-bottom)$/i.test(v);
  return true;
}
export function scopeCss(text, scope) {
  if (!text || text.length > 800000) return '';
  let sheet;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(text.replace(/@import[^;]*;/gi, '')); } catch { return ''; }
  const out = [];
  for (const r of sheet.cssRules) {
    if (r.type !== 1) continue;                                   // plain style rules only
    const decl = [];
    for (let i = 0; i < r.style.length; i++) {
      const p = r.style[i];
      if (KEEP_PROP.test(p)) { const v = r.style.getPropertyValue(p); if (okValue(p, v)) decl.push(p + ':' + v); }
    }
    if (!decl.length) continue;
    const sel = r.selectorText;
    if (/\([^)]*,[^)]*\)/.test(sel) || /::?(before|after|first-line|first-letter|marker)/i.test(sel)) continue;
    const scoped = sel.split(',').map((s) => {
      s = s.trim().replace(/^(?:html\s*)?(?:body|:root)\b\s*/i, '');
      return s ? scope + ' ' + s : scope;
    }).join(',');
    out.push(scoped + '{' + decl.join(';') + '}');
  }
  return out.join('\n');
}
function filterStyle(str) {
  const keep = [];
  for (const d of String(str).split(';')) {
    const i = d.indexOf(':'); if (i < 1) continue;
    const p = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
    const name = p === 'text-decoration' ? 'text-decoration-line' : p === 'font-variant' ? 'font-variant-caps' : p;
    if (KEEP_PROP.test(name) && okValue(name, v)) keep.push(name + ':' + v);
  }
  return keep.join(';');
}

/* ---------------- sanitise ---------------- */
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
export function sanitize(root, base, selfPath) {
  for (const el of [...root.querySelectorAll(DROP)]) el.remove();
  const tw = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments = []; while (tw.nextNode()) comments.push(tw.currentNode);
  comments.forEach((c) => c.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const at of [...el.attributes]) if (/^on/i.test(at.name) || at.name === 'srcset' || at.name === 'sizes') el.removeAttribute(at.name);
    if (el.hasAttribute('style')) { const st = filterStyle(el.getAttribute('style')); if (st) el.setAttribute('style', st); else el.removeAttribute('style'); }
    const tag = el.localName;
    if (tag === 'a') {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      el.removeAttribute('href'); el.removeAttribute('xlink:href'); el.removeAttribute('target');
      if (!href) continue;
      if (/^(https?|mailto|tel):/i.test(href)) { el.setAttribute('data-ext', href); continue; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;              // javascript:, data:, file: … ignored
      const hash = href.indexOf('#');
      const p = hash < 0 ? href : href.slice(0, hash);
      el.setAttribute('data-href', p ? resolvePath(base, p) : selfPath);
      el.setAttribute('data-frag', hash < 0 ? '' : safeDecode(href.slice(hash + 1)));
      const type = (el.getAttribute('epub:type') || '') + ' ' + (el.getAttribute('role') || '');
      const txt = el.textContent.trim();
      if (/noteref/.test(type) || (el.parentElement && /^(sup|sub)$/.test(el.parentElement.localName) && /^[[(]?[\d*†‡§a-z]{1,4}[\])]?$/i.test(txt))) {
        el.classList.add('fn'); el.setAttribute('data-note', '1');
      } else if (/^[[(]?\d{1,3}[\])]?$|^[*†‡§]+$/.test(txt)) el.setAttribute('data-note', '?');
    } else if (tag === 'img' || tag === 'image') {
      const src = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      el.removeAttribute('src'); el.removeAttribute('href'); el.removeAttribute('xlink:href');
      if (src && !/^(https?:|data:)/i.test(src)) el.setAttribute('data-p', resolvePath(base, src));
      else if (/^data:image\//i.test(src)) { if (tag === 'img') el.setAttribute('src', src); else el.setAttribute('href', src); }
      if (tag === 'img') { el.setAttribute('decoding', 'async'); el.removeAttribute('loading'); }
    }
  }
}

/* ---------------- section loading ---------------- */
/**
 * → { s, path, lang, total, parts:[{el, chars, base}], ids:Map(id→partIndex), css }
 */
export async function loadSection(zip, item, s, cssCache, { css = true, limit = PART_LIMIT } = {}) {
  const text = await zip.text(item.href);
  const doc = parseHtml(text);
  const base = dirname(item.href);
  let cssText = '';
  if (css) {
    const bits = [];
    for (const st of doc.querySelectorAll('style')) bits.push(st.textContent);
    for (const l of doc.querySelectorAll('link')) {
      if (!/stylesheet/i.test(l.getAttribute('rel') || '')) continue;
      const p = resolvePath(base, l.getAttribute('href') || '');
      if (!p || !zip.has(p)) continue;
      if (!cssCache.has(p)) cssCache.set(p, zip.text(p).catch(() => ''));
      bits.push(await cssCache.get(p));
    }
    cssText = scopeCss(bits.join('\n'), `.ep-body[data-s="${s}"]`);
  }
  const body = doc.body || doc.documentElement;
  sanitize(body, base, item.href);
  const lang = doc.documentElement.getAttribute('lang') || doc.documentElement.getAttribute('xml:lang') || '';
  return { s, path: item.href, lang, css: cssText, ...splitParts(body, limit) };
}

function splitParts(body, limit) {
  const total = body.textContent.length;
  const items = [];
  const expand = (parent, chain, depth) => {
    for (const n of [...parent.childNodes]) {
      if (n.nodeType === 1 && depth < 6 && GENERIC.has(n.localName) && n.childElementCount && n.textContent.length > limit * 1.4) expand(n, [...chain, n], depth + 1);
      else items.push({ node: n, chain });
    }
  };
  if (total > limit * 1.4) expand(body, [], 0); else { const none = []; for (const n of [...body.childNodes]) items.push({ node: n, chain: none }); }
  const groups = []; let cur = null;
  for (const it of items) {
    const len = it.node.nodeType === 3 ? it.node.data.length : it.node.textContent.length;
    if (!cur || cur.chain !== it.chain || cur.chars >= limit) { cur = { chain: it.chain, nodes: [], chars: 0 }; groups.push(cur); }
    cur.nodes.push(it.node); cur.chars += len;
  }
  if (!groups.length) groups.push({ chain: [], nodes: [], chars: 0 });
  const parts = []; const ids = new Map(); const seen = new Set(); let base = 0;
  groups.forEach((g, i) => {
    const el = document.createElement('div');
    el.className = 'ep-part'; el.dataset.p = i;
    let inner = el;
    for (const w of g.chain) {
      const c = w.cloneNode(false);
      if (c.id) { if (seen.has(c.id)) c.removeAttribute('id'); else seen.add(c.id); }
      inner.append(c); inner = c;
    }
    for (const n of g.nodes) inner.append(n);
    for (const e of el.querySelectorAll('[id]')) if (!ids.has(e.id)) ids.set(e.id, i);
    for (const e of el.querySelectorAll('a[name]')) { const n = e.getAttribute('name'); if (n && !ids.has(n)) ids.set(n, i); }
    parts.push({ el, chars: g.chars, base });
    base += g.chars;
  });
  return { total: base, parts, ids };
}

/** Point <img>/<image> elements at blob URLs from the archive. urlFor(path) → Promise<string> */
export async function attachImages(sec, urlFor) {
  const jobs = [];
  for (const part of sec.parts) {
    for (const el of part.el.querySelectorAll('[data-p]')) {
      const p = el.getAttribute('data-p');
      if (!p) continue;
      jobs.push(urlFor(p).then((u) => {
        if (!u) return;
        if (el.localName === 'img') el.src = u; else el.setAttribute('href', u);
      }).catch(() => {}));
    }
  }
  await Promise.all(jobs);
}

export const hasMedia = (part) => !!part.el.querySelector('img,svg,image');
export function findById(sec, id) {
  const pi = sec.ids.get(id);
  if (pi == null) return null;
  const el = sec.parts[pi].el;
  const safe = CSS.escape(id);
  return { part: pi, el: el.querySelector(`[id="${safe}"]`) || el.querySelector(`a[name="${safe}"]`) || (el.id === id ? el : null) };
}

/* ---------------- character offsets ---------------- */
export function offsetIn(rootEl, node, off) {
  const r = rootEl.ownerDocument.createRange();
  r.setStart(rootEl, 0);
  try { r.setEnd(node, off); } catch { return 0; }
  return r.toString().length;
}
export function pointAt(rootEl, offset) {
  const tw = rootEl.ownerDocument.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  let n, acc = 0, last = null;
  while ((n = tw.nextNode())) {
    const len = n.data.length;
    if (/\S/.test(n.data)) {
      if (acc + len > offset) {
        const from = Math.max(0, offset - acc);
        const m = n.data.slice(from).search(/\S/);
        if (m >= 0) return { node: n, off: from + m };
      }
      last = n;
    }
    acc += len;
  }
  return last ? { node: last, off: Math.max(0, last.data.search(/\S\s*$/)) } : null;
}
/** wrap characters [from,to) of partEl in elements made by make(); returns the elements */
export function wrapChars(partEl, from, to, make) {
  const tw = partEl.ownerDocument.createTreeWalker(partEl, NodeFilter.SHOW_TEXT);
  const segs = []; let n, acc = 0;
  while ((n = tw.nextNode())) {
    const len = n.data.length, a0 = acc; acc += len;
    if (acc <= from) continue;
    if (a0 >= to) break;
    const a = Math.max(from - a0, 0), b = Math.min(to - a0, len);
    if (b > a && /\S/.test(n.data.slice(a, b))) segs.push({ n, a, b });
  }
  const out = [];
  for (const g of segs) {
    let t = g.n;
    if (g.b < t.data.length) t.splitText(g.b);
    if (g.a > 0) t = t.splitText(g.a);
    const m = make();
    t.parentNode.insertBefore(m, t); m.append(t);
    out.push(m);
  }
  return out;
}
export function unwrapAll(partEl, selector) {
  const marks = partEl.querySelectorAll(selector);
  if (!marks.length) return;
  for (const m of marks) m.replaceWith(...m.childNodes);
  partEl.normalize();
}

/** caret under a viewport point → {node, off} */
export function caretAt(x, y) {
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, off: p.offset } : null; }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, off: r.startOffset } : null;
}

/** plain text of a section for search, plus the offsets where one block ends and the next begins (for readable snippets) */
const BLOCK = 'p,div,li,h1,h2,h3,h4,h5,h6,section,article,aside,blockquote,td,th,tr,dd,dt,figure,figcaption,pre,body';
export async function sectionText(zip, item, s, cache) {
  if (cache.has(s)) return cache.get(s);
  const sec = await loadSection(zip, item, s, new Map(), { css: false, limit: 1e9 });
  const root = sec.parts[0].el;
  const bounds = [];
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n, acc = 0, prev = null;
  while ((n = tw.nextNode())) {
    const blk = n.parentElement?.closest(BLOCK) || root;
    if (prev && blk !== prev && n.data.length) bounds.push(acc);
    prev = blk; acc += n.data.length;
  }
  const out = { text: root.textContent, bounds };
  cache.set(s, out);
  return out;
}
/** slice of text [a,b) with a space wherever a block boundary falls inside */
export function snippetOf({ text, bounds }, a, b) {
  let out = '', from = a;
  for (const k of bounds) { if (k <= a || k >= b) continue; out += text.slice(from, k) + ' '; from = k; }
  return (out + text.slice(from, b)).replace(/\s+/g, ' ');
}
