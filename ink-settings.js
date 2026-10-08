/* INK — settings store + application of app-wide appearance */
import * as db from './ink-db.js';
import { Emitter } from './ink-util.js';

export const DEFAULTS = {
  app: { theme: 'system', animations: true, textScale: 1, highContrast: false, dyslexia: false, reduceMotion: false },
  reading: {
    theme: 'auto',            // auto = follows the app theme
    customBg: '#f6f1e4', customFg: '#24211b',
    font: 'serif',            // serif | sans | humanist | mono | dyslexic
    size: 19, lineHeight: 1.6, letterSpacing: 0, wordSpacing: 0, paraSpacing: 0.7,
    firstLineIndent: 0,       // em
    margin: 22, align: 'left', columnWidth: 640,
    flow: 'paged',            // paged | scroll
    autoHide: true, tapNav: true,
    chapterStop: false,       // stop at chapter end and offer Continue
    showTimeLeft: true,
    direction: 'ltr',         // default direction for comics
  },
  library: { view: 'grid', sort: 'added', sortDir: 'desc', gridSize: 'm', group: true, filter: 'all', showProgress: true },
  pdf: { mode: 'continuous', fit: 'width', trim: false },
  comic: { mode: 'auto', fit: 'auto', brightness: 1, contrast: 1, sharpen: false, trim: false, firstPageAlone: true },
};

const bus = new Emitter();
let state = structuredClone(DEFAULTS);

function merge(base, over) {
  for (const k of Object.keys(base)) {
    if (over && k in over) {
      if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) merge(base[k], over[k]);
      else if (typeof over[k] === typeof base[k]) base[k] = over[k];
    }
  }
  return base;
}

export async function load() {
  const saved = await db.kvGet('settings', null);
  state = merge(structuredClone(DEFAULTS), saved || {});
  applyApp();
  return state;
}

let saveT;
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => db.kvSet('settings', state).catch(() => {}), 150);
  try {
    localStorage.setItem('ink-boot', JSON.stringify({ t: state.app.theme, a: state.app.animations, s: state.app.textScale, hc: state.app.highContrast, d: state.app.dyslexia, rm: state.app.reduceMotion }));
  } catch { /* private mode */ }
}

export function get(path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), state);
}
export function all() { return state; }
export function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const obj = keys.reduce((o, k) => o[k], state);
  if (obj[last] === value) return;
  obj[last] = value;
  persist();
  if (keys[0] === 'app' || path.startsWith('app.')) applyApp();
  bus.emit('change', path);
  bus.emit(path, value);
}
export function on(fn) { return bus.on('change', fn); }
export function onKey(path, fn) { return bus.on(path, fn); }
export function reset(section) {
  state[section] = structuredClone(DEFAULTS[section]);
  persist();
  if (section === 'app') applyApp();
  bus.emit('change', section);
}

/* ---- app appearance ---- */
const mqDark = matchMedia('(prefers-color-scheme: dark)');
const mqMotion = matchMedia('(prefers-reduced-motion: reduce)');
const mqContrast = matchMedia('(prefers-contrast: more)');

export function resolvedTheme() {
  const t = state.app.theme;
  return t === 'system' ? (mqDark.matches ? 'dark' : 'light') : t;
}
export function motionReduced() {
  return !state.app.animations || state.app.reduceMotion || mqMotion.matches;
}
export function applyApp() { applyAppearance(state.app); }

export function applyAppearance(a) {
  const root = document.documentElement;
  const theme = a.t ?? a.theme;
  const resolved = theme === 'system' ? (mqDark.matches ? 'dark' : 'light') : theme;
  root.dataset.theme = resolved;
  const hc = a.hc ?? a.highContrast;
  if (hc || mqContrast.matches) root.dataset.hc = ''; else delete root.dataset.hc;
  const anim = a.a ?? a.animations, rm = a.rm ?? a.reduceMotion;
  if (!anim || rm || mqMotion.matches) root.dataset.motion = 'reduce'; else delete root.dataset.motion;
  if (a.d ?? a.dyslexia) root.dataset.dyslexia = ''; else delete root.dataset.dyslexia;
  root.style.setProperty('--ui-scale', String(a.s ?? a.textScale ?? 1));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = { light: '#f4f0e7', dark: '#0c0c0e', oled: '#000000' }[resolved];
}

[mqDark, mqMotion, mqContrast].forEach((m) => m.addEventListener?.('change', () => { applyApp(); bus.emit('change', 'app.system'); }));

/* ---- reading themes (independent of the app theme) ---- */
export const READING_THEMES = {
  light: { name: 'Light', bg: '#f8f6f0', fg: '#1f1d19', link: '#8f5a1c', muted: '#7c766a' },
  sepia: { name: 'Sepia', bg: '#efe2c6', fg: '#43341f', link: '#8a4b12', muted: '#8a775a' },
  dark: { name: 'Dark', bg: '#1e1e21', fg: '#d6d3cb', link: '#e0b36e', muted: '#8d8a82' },
  oled: { name: 'OLED', bg: '#000000', fg: '#bdbab2', link: '#d8a65c', muted: '#7a776f' },
};
export function readingTheme() {
  const r = state.reading;
  if (r.theme === 'custom') return { name: 'Custom', bg: r.customBg, fg: r.customFg, link: r.customFg, muted: r.customFg };
  if (r.theme === 'auto') {
    const t = resolvedTheme();
    return READING_THEMES[t === 'light' ? 'light' : t === 'oled' ? 'oled' : 'dark'];
  }
  return READING_THEMES[r.theme] || READING_THEMES.light;
}
export const FONT_STACKS = {
  serif: 'Newsreader, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  sans: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  humanist: '"Atkinson Hyperlegible", Seravek, "Gill Sans Nova", Calibri, "Segoe UI", Verdana, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  dyslexic: 'OpenDyslexic, "Lexend", "Atkinson Hyperlegible", "Comic Sans MS", Verdana, sans-serif',
};
export function readingFontStack(override) {
  const font = override?.font ?? state.reading.font;
  return FONT_STACKS[state.app.dyslexia ? 'dyslexic' : font] || FONT_STACKS.serif;
}

/** Keys that can be overridden per-book */
export const BOOK_PREF_KEYS = [
  'theme', 'customBg', 'customFg', 'font', 'size', 'lineHeight', 'letterSpacing', 'wordSpacing',
  'firstLineIndent', 'paraSpacing', 'margin', 'align', 'columnWidth', 'flow', 'chapterStop', 'tapNav', 'showTimeLeft',
];

/** Merge global reading settings with optional per-book overrides */
export function effectiveReading(bookPrefs) {
  const base = { ...state.reading };
  if (!bookPrefs || typeof bookPrefs !== 'object') return base;
  for (const k of BOOK_PREF_KEYS) {
    if (bookPrefs[k] !== undefined && bookPrefs[k] !== null) base[k] = bookPrefs[k];
  }
  return base;
}

export function readingThemeFor(prefs) {
  const r = prefs || state.reading;
  if (r.theme === 'custom') return { name: 'Custom', bg: r.customBg, fg: r.customFg, link: r.customFg, muted: r.customFg };
  if (r.theme === 'auto') {
    const t = resolvedTheme();
    return READING_THEMES[t === 'light' ? 'light' : t === 'oled' ? 'oled' : 'dark'];
  }
  return READING_THEMES[r.theme] || READING_THEMES.light;
}
