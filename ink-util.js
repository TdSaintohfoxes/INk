/* INK — small shared helpers (no dependencies) */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'indeterminate', 'tabIndex']);

/** Tiny hyperscript: h('div', {class:'x', onclick:fn}, child, [children]) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

/* ---- icons (24px line icons) ---- */
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="12" cy="5.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="18.5" r="1.2"/>',
  library: '<path d="M5 4v16M10 4v16M15 5l4 15"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>',
  bookmark: '<path d="M7 4h10v16l-5-4-5 4z"/>',
  bookmarkOn: '<path d="M7 4h10v16l-5-4-5 4z" fill="currentColor"/>',
  toc: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  type: '<path d="M4 19l6-14 6 14M6.5 14h7M15 19l3.5-8 3 8M16.5 17h4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.5M4 12h.5M4 18h.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  heartOn: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="currentColor"/>',
  chevR: '<path d="M9 5l7 7-7 7"/>',
  chevL: '<path d="M15 5l-7 7 7 7"/>',
  chevD: '<path d="M5 9l7 7 7-7"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2M8 11h6"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  thumbs: '<rect x="4" y="3.5" width="7" height="9" rx="1"/><rect x="13" y="3.5" width="7" height="9" rx="1"/><rect x="4" y="14.5" width="7" height="6" rx="1"/><rect x="13" y="14.5" width="7" height="6" rx="1"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-4 3.7-6 7-6s6.2 2 7 6"/>',
  ruler: '<rect x="3.5" y="9" width="17" height="6" rx="1"/><path d="M7 9v3M10.5 9v2M14 9v3M17.5 9v2"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  folder: '<path d="M3.5 6.5h6l2 2.5h9v9.5h-17z"/>',
  collection: '<rect x="5" y="7" width="14" height="13" rx="1.5"/><path d="M8 4h8"/>',
  book: '<path d="M5 4.5h10a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10"/>',
  comic: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16M12 4v8M9 12v8"/>',
  pdf: '<path d="M6 3.5h8l4 4V20.5H6zM14 3.5v4h4"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  highlight: '<path d="M4 20h7M14.5 5.5l4 4-8 8H6.5v-4z"/>',
  note: '<path d="M5 4h14v12l-4 4H5zM15 16v4M8 9h8M8 13h4"/>',
  split: '<rect x="3.5" y="5" width="8" height="14" rx="1"/><rect x="12.5" y="5" width="8" height="14" rx="1"/>',
  single: '<rect x="7" y="4.5" width="10" height="15" rx="1"/>',
  scroll: '<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.01"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  warn: '<path d="M12 4l9 16H3zM12 10v4.5M12 17.4v.01"/>',
};
export function icon(name, size = 22, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.7');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = ICONS[name] || '';
  return s;
}

/* ---- misc ---- */
export const uid = () =>
  (self.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
export const natCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
export const idle = (fn, timeout = 1500) =>
  'requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 60);

export function debounce(fn, ms = 200) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}
export function rafThrottle(fn) {
  let q = false, last;
  return (...a) => { last = a; if (q) return; q = true; requestAnimationFrame(() => { q = false; fn(...last); }); };
}
export function withTimeout(p, ms, msg = 'Timed out') {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}
export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}
export function fmtMinutes(m) {
  m = Math.max(0, Math.round(m));
  if (m < 1) return 'less than a minute';
  if (m < 60) return m + ' min';
  const hh = Math.floor(m / 60), mm = m % 60;
  return hh + ' h' + (mm ? ' ' + mm + ' min' : '');
}
export function fmtDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
export const pct = (p) => Math.round(clamp(p || 0, 0, 1) * 100);
export function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}
export function hashHue(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x % 360;
}
export const isCoarse = () => matchMedia('(pointer:coarse)').matches;

/** Tiny event bus */
export class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) { (this._l.get(ev) || this._l.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._l.get(ev)?.delete(fn); }
  emit(ev, data) { this._l.get(ev)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
}
export const bus = new Emitter();
