/* INK — dictionary lookup. Offline pack first (imported by the reader), then words you looked up before.
 * Online lookup is opt-in: nothing leaves the device unless you allow it (or tap "Look up online" for one word). */
import { h, icon } from './ink-util.js';
import * as db from './ink-db.js';
import * as settings from './ink-settings.js';
import { openSheet, toast } from './ink-ui.js';

let pack = null, cache = null;
const norm = (w) => String(w || '').toLowerCase().replace(/[’]/g, "'").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');

async function loadPack() { if (pack === null) pack = (await db.kvGet('dictpack', null)) || {}; return pack; }
async function loadCache() { if (cache === null) cache = (await db.kvGet('dictcache', null)) || {}; return cache; }

export async function packSize() { return Object.keys(await loadPack()).length; }
export async function clearPack() { pack = {}; await db.kvSet('dictpack', {}); }

/** Accepts JSON ({word: "definition" | ["def", …] | [{pos, def}]}), or text lines "word<TAB>definition" / "word: definition" / "word - definition". */
export async function importPack(file) {
  const text = await file.text();
  const out = { ...(await loadPack()) };
  let n = 0;
  const add = (w, v) => {
    w = norm(w); if (!w || v == null) return;
    const defs = (Array.isArray(v) ? v : [v]).map((d) => (typeof d === 'string' ? ['', d] : [d.pos || d[0] || '', d.def || d.definition || d[1] || ''])).filter((d) => d[1]);
    if (!defs.length) return;
    (out[w] ||= []).push(...defs.slice(0, 6)); n++;
  };
  let parsed = null;
  if (/^\s*[{[]/.test(text)) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
  if (parsed && !Array.isArray(parsed)) for (const [w, v] of Object.entries(parsed)) add(w, v);
  else if (Array.isArray(parsed)) for (const r of parsed) add(r.word || r.w || r[0], r.defs || r.definition || r.def || r.d || r[1]);
  else for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\p{L}'’-]+)\s*(?:\t|:\s|\s-\s|\s—\s)\s*(.+)$/u);
    if (m) add(m[1], m[2]);
  }
  if (!n) throw new Error('No definitions found in that file.');
  pack = out;
  await db.kvSet('dictpack', out);
  return n;
}

function variants(w) {
  const v = [w];
  const strip = (suf, add = '') => { if (w.length > suf.length + 2 && w.endsWith(suf)) v.push(w.slice(0, -suf.length) + add); };
  strip("'s"); strip('ies', 'y'); strip('es'); strip('s'); strip('ied', 'y'); strip('ed'); strip('ed', 'e'); strip('ing'); strip('ing', 'e'); strip('ly'); strip('er'); strip('est'); strip('ness'); strip('ful');
  const dbl = w.match(/^(.+?)(.)\2(ed|ing|er|est)$/); if (dbl) v.push(dbl[1] + dbl[2]);
  return [...new Set(v)];
}

async function fetchOnline(w) {
  const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w));
  if (!r.ok) return null;
  const j = await r.json();
  const defs = [];
  for (const e of j) for (const m of e.meanings || []) for (const d of (m.definitions || []).slice(0, 3)) defs.push([m.partOfSpeech || '', d.definition]);
  if (!defs.length) return null;
  const c = await loadCache(); c[w] = defs.slice(0, 8);
  const keys = Object.keys(c); if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete c[k];
  db.kvSet('dictcache', c).catch(() => {});
  return c[w];
}

/** → { word, defs: [[pos, def]], source } | null */
export async function lookup(raw, { online = false } = {}) {
  const word = norm(raw); if (!word) return null;
  const [p, c] = await Promise.all([loadPack(), loadCache()]);
  for (const w of variants(word)) {
    if (p[w]) return { word: w === word ? word : `${word} → ${w}`, defs: p[w], source: 'Offline dictionary' };
    if (c[w]) return { word: w === word ? word : `${word} → ${w}`, defs: c[w], source: 'Saved from an earlier lookup' };
  }
  if (online) {
    try { const d = await fetchOnline(word); if (d) return { word, defs: d, source: 'dictionaryapi.dev (online)' }; } catch { /* offline */ }
  }
  return null;
}

/** Shows a glass definition card for a selected word. */
export async function define(raw) {
  const word = norm(raw);
  const body = h('div', { class: 'def-body' }, h('div', { class: 'row-hint' }, 'Looking up…'));
  openSheet({ title: '', noHeader: true, size: 's', className: 'rd-define-sheet', body: () => body });
  const show = (res, tried) => {
    body.replaceChildren();
    if (res) {
      body.append(h('div', { class: 'def-word' }, res.word));
      const groups = new Map();
      for (const [pos, d] of res.defs) { if (!groups.has(pos)) groups.set(pos, []); groups.get(pos).push(d); }
      for (const [pos, ds] of groups) body.append(h('div', { class: 'def-group' }, pos ? h('div', { class: 'def-pos' }, pos) : null,
        h('ol', { class: 'def-list' }, ds.slice(0, 4).map((d) => h('li', null, d)))));
      body.append(h('div', { class: 'def-src' }, res.source));
    } else {
      body.append(h('div', { class: 'def-word' }, word || raw),
        h('p', { class: 'row-hint' }, tried ? 'No definition found for this word.' : 'This word isn’t in your offline dictionary yet.'),
        tried ? null : h('button', { class: 'btn', onclick: async () => {
          body.replaceChildren(h('div', { class: 'row-hint' }, 'Looking up…'));
          show(await lookup(word, { online: true }), true);
        } }, 'Look up online'),
        tried ? null : h('p', { class: 'row-hint', style: { marginTop: '8px' } }, 'Sends just this word to dictionaryapi.dev. Add a dictionary file in Settings to work fully offline.'));
    }
  };
  const res = await lookup(word, { online: !!settings.get('app.dictOnline') });
  show(res, !!settings.get('app.dictOnline'));
}

export const isWord = (t) => /^[\p{L}][\p{L}'’-]{1,28}$/u.test(String(t || '').trim());
