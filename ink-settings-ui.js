/* INK — Settings (Appearance · Reading · Library · Storage · Accessibility · About) and reading statistics */
import { h, icon, fmtBytes, fmtMinutes } from './ink-util.js';
import * as settings from './ink-settings.js';
import * as db from './ink-db.js';
import * as lib from './ink-lib.js';
import * as stats from './ink-stats.js';
import * as dict from './ink-dict.js';
import * as backup from './ink-backup.js';
import { openSheet, segmented, slider, toggleRow, field, group, swatches, toast, confirmDialog } from './ink-ui.js';

const S = settings;

export function renderSettings(root, ctx) {
  const inner = h('div', { class: 'view-inner view-in' });
  root.replaceChildren(inner);
  inner.append(
    h('header', { class: 'top' }, h('span', { class: 'wordmark small' }, 'INK')),
    h('h1', { class: 'page-title', style: { marginBottom: '8px' } }, 'Settings'),
    settingsSearch(inner),
    h('button', { class: 'row link', onclick: showStats }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, 'Reading statistics'), h('span', { class: 'row-hint' }, 'Time, books finished, pace — private to this device')), icon('chevR', 18)),

    group('Appearance',
      field('App theme', segmented([{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'oled', label: 'OLED' }], S.get('app.theme'), (v) => S.set('app.theme', v))),
      readingThemeField(),
      toggleRow({ label: 'Animations', hint: 'Page and screen transitions', value: S.get('app.animations'), onChange: (v) => S.set('app.animations', v) })),

    group('Reading',
      h('p', { class: 'row-hint', style: { margin: '2px 0 8px' } }, 'Defaults for every book. A book you have adjusted from its own reader menu keeps its own look.'),
      field('Page behavior', segmented([{ value: 'paged', label: 'Pages', icon: 'single' }, { value: 'chapter', label: 'Chapter', icon: 'scroll' }, { value: 'scroll', label: 'Scroll', icon: 'scroll' }], S.get('reading.flow'), (v) => S.set('reading.flow', v)), 'For EPUB. Chapter = scroll within a chapter, swipe sideways between chapters.'),
      field('Default font', segmented([{ value: 'serif', label: 'Serif' }, { value: 'sans', label: 'Sans' }, { value: 'humanist', label: 'Humanist' }, { value: 'mono', label: 'Mono' }], S.get('reading.font'), (v) => S.set('reading.font', v), { wrap: true })),
      slider({ label: 'Default margins', min: 4, max: 80, step: 2, value: S.get('reading.margin'), format: (v) => v + ' px', onInput: (v) => S.set('reading.margin', v) }),
      field('Default reading direction', segmented([{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left (manga)' }], S.get('reading.direction'), (v) => S.set('reading.direction', v)), 'Used for comics unless the file says otherwise.'),
      toggleRow({ label: 'Auto-hide controls', hint: 'Controls fade away while you read', value: S.get('reading.autoHide'), onChange: (v) => S.set('reading.autoHide', v) }),
      toggleRow({ label: 'Reading ruler', hint: 'Dims everything except a few lines you can drag. Also in the ⋯ menu.', value: S.get('reading.ruler'), onChange: (v) => S.set('reading.ruler', v) }),
      toggleRow({ label: 'Tap edges to turn pages', value: S.get('reading.tapNav'), onChange: (v) => S.set('reading.tapNav', v) })),

    group('Library',
      field('Sort order', segmented(lib.SORTS.slice(0, 3).map(([value, label]) => ({ value, label: label.replace('Recently ', '') })), S.get('library.sort'), (v) => { S.set('library.sort', v); S.set('library.sortDir', lib.defaultDir(v)); }), 'More options in the library toolbar.'),
      field('Grid size', segmented([{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'Large' }], S.get('library.gridSize'), (v) => S.set('library.gridSize', v))),
      toggleRow({ label: 'Group series automatically', hint: 'Volumes with matching names are stacked. You can always fix a book by hand.', value: S.get('library.group'), onChange: (v) => S.set('library.group', v) }),
      toggleRow({ label: 'Progress on covers', value: S.get('library.showProgress'), onChange: (v) => S.set('library.showProgress', v) })),

    dictionaryGroup(),

    backupGroup(ctx),

    storageGroup(ctx),

    group('Accessibility',
      slider({ label: 'Interface text size', min: 0.9, max: 1.4, step: 0.05, value: S.get('app.textScale'), format: (v) => Math.round(v * 100) + '%', onInput: (v) => S.set('app.textScale', v) }),
      toggleRow({ label: 'Dyslexia-friendly font', hint: 'Uses a wide-spaced, easy-to-tell-apart typeface in the app and in books', value: S.get('app.dyslexia'), onChange: (v) => S.set('app.dyslexia', v) }),
      toggleRow({ label: 'High contrast', value: S.get('app.highContrast'), onChange: (v) => S.set('app.highContrast', v) }),
      toggleRow({ label: 'Reduce motion', value: S.get('app.reduceMotion'), onChange: (v) => S.set('app.reduceMotion', v) })),

    group('About',
      h('div', { class: 'row' }, h('span', { class: 'row-label' }, 'Version'), h('span', { class: 'val' }, 'INK 1.0')),
      h('button', { class: 'row link', onclick: showLicenses }, h('span', { class: 'row-label' }, 'Licenses & acknowledgements'), icon('chevR', 18)),
      h('p', { class: 'row-hint', style: { marginTop: '14px', maxWidth: '52ch' } }, 'INK is local-first. Your books, notes and reading history stay on this device. Nothing is uploaded, and no account is needed.'),
      h('button', { class: 'btn ghost', style: { marginTop: '18px' }, onclick: async () => { if (await confirmDialog({ title: 'Reset settings?', message: 'Your books and progress are not affected.', confirmLabel: 'Reset' })) { ['app', 'reading', 'library', 'pdf', 'comic'].forEach((s) => S.reset(s)); location.reload(); } } }, 'Reset all settings')));
}

function settingsSearch(inner) {
  const input = h('input', { type: 'search', class: 'set-search-in', placeholder: 'Search settings', 'aria-label': 'Search settings', autocomplete: 'off' });
  const empty = h('p', { class: 'row-hint set-empty', hidden: true }, 'No settings match that.');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let any = false;
    inner.querySelectorAll('.group').forEach((g) => {
      const titleHit = !q || g.querySelector('.group-title')?.textContent.toLowerCase().includes(q);
      let hits = 0;
      g.querySelectorAll(':scope > .row, :scope > .field, :scope > .slider, :scope > p, :scope > div').forEach((r) => {
        const on = titleHit || r.textContent.toLowerCase().includes(q);
        r.hidden = !on; if (on) hits++;
      });
      g.hidden = !titleHit && !hits; if (!g.hidden) any = true;
    });
    inner.querySelectorAll(':scope > .row.link').forEach((r) => { r.hidden = !!q && !r.textContent.toLowerCase().includes(q); if (!r.hidden) any = true; });
    empty.hidden = !q || any;
  });
  return h('div', { class: 'set-search' }, icon('search', 18), input, empty);
}

function themePreview() {
  const page = h('div', { class: 'tp-page' },
    h('div', { class: 'tp-h' }, 'Chapter One'),
    h('p', null, 'The mist rolled in from the sea, soft as breath on glass, and the town below began to forget its own name.'),
    h('p', null, 'She read by the last of the light, turning each page slowly, as though the book might notice.'));
  const apply = () => {
    const r = S.all().reading, t = S.readingThemeFor();
    page.style.background = t.bg; page.style.color = t.fg;
    page.style.fontFamily = S.readingFontStack(r);
    page.style.fontSize = Math.round(Math.min(22, Math.max(13, r.size * 0.8))) + 'px';
    page.style.lineHeight = String(r.lineHeight);
    page.style.textAlign = r.align === 'justify' ? 'justify' : 'left';
    page.style.padding = `14px ${Math.round(Math.min(34, 10 + r.margin * 0.5))}px`;
  };
  apply();
  const off = S.on((k) => { if (!document.body.contains(page) && page.dataset.live) { off(); return; } if (/^(reading|app)\./.test(k)) apply(); });
  page.dataset.live = '1';
  return h('div', { class: 'tp-wrap', 'aria-hidden': 'true' }, page);
}

function readingThemeField() {
  const items = [{ value: 'auto', label: 'Auto', bg: 'linear-gradient(135deg,#f8f6f0 50%,#1e1e21 50%)', fg: '#888' }]
    .concat(Object.entries(S.READING_THEMES).map(([value, t]) => ({ value, label: t.name, bg: t.bg, fg: t.fg })))
    .concat([{ value: 'custom', label: 'Custom', bg: S.get('reading.customBg'), fg: S.get('reading.customFg') }]);
  const custom = h('div', { style: { display: S.get('reading.theme') === 'custom' ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' } },
    colorField('Background', 'reading.customBg'), colorField('Text', 'reading.customFg'));
  const sw = swatches(items, S.get('reading.theme'), (v) => { S.set('reading.theme', v); custom.style.display = v === 'custom' ? 'grid' : 'none'; });
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Reading theme'), sw, custom, themePreview(),
    h('div', { class: 'row-hint' }, 'Independent from the app theme — read on warm paper in a dark app if you like.'));
}
function colorField(label, path) {
  const input = h('input', { type: 'color', class: 'color-input', value: S.get(path), 'aria-label': label });
  input.addEventListener('input', () => S.set(path, input.value));
  return h('div', null, h('div', { class: 'field-label' }, label), input);
}

function storageGroup(ctx) {
  const usage = h('div', { class: 'row-hint' }, 'Calculating…');
  const bar = h('i', { style: { width: '0%' } });
  const persist = h('span', { class: 'val' }, '');
  const refresh = async () => {
    const info = await db.storageInfo();
    const books = lib.books();
    const bytes = books.reduce((n, b) => n + (b.size || 0), 0);
    usage.textContent = `${books.length} item${books.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} of books · ${fmtBytes(info.usage)} used of ${info.quota ? fmtBytes(info.quota) : 'available space'}`;
    bar.style.width = info.quota ? Math.min(100, (info.usage / info.quota) * 100) + '%' : '0%';
    persist.textContent = info.persisted ? 'Protected' : 'Not protected';
  };
  refresh();
  return group('Storage',
    h('p', { class: 'row-hint', style: { margin: '4px 0 10px' } }, 'Books you import are copied into INK’s private storage on this device. The original files are never changed.'),
    h('div', { class: 'progress-line' }, bar), usage,
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, 'Keep my library safe'), h('span', { class: 'row-hint' }, 'Asks the browser not to clear INK’s storage when space runs low')), persist),
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '14px' } },
      h('button', { class: 'btn ghost', onclick: async () => { const ok = await db.requestPersistence(); toast(ok ? 'Library protected' : 'The browser declined — installing INK to your home screen usually helps'); refresh(); } }, 'Protect storage'),
      h('button', { class: 'btn ghost', onclick: () => ctx.pickFolder() }, icon('folder', 18), 'Import folder'),
      h('button', { class: 'btn ghost', onclick: () => duplicatesSheet(refresh) }, 'Find duplicates'),
      h('button', { class: 'btn ghost', onclick: async () => { toast('Rebuilding covers…'); await ctx.rebuildCovers(); toast('Covers rebuilt'); } }, 'Rebuild covers')));
}

function duplicatesSheet(done) {
  const groups = lib.findDuplicates();
  openSheet({ title: 'Duplicates', body: (api) => {
    if (!groups.length) return h('p', { class: 'row-hint', style: { margin: '8px 0 16px' } }, 'No duplicates found — nothing in your library looks like a repeat.');
    const del = new Set(), rows = [];
    const body = h('div', null, h('p', { class: 'row-hint', style: { margin: '4px 0 12px' } }, 'These look like the same book. The copy with the most progress is kept by default — tick any you want removed.'));
    const btn = h('button', { class: 'btn primary danger', onclick: async () => {
      if (!del.size) return;
      if (!await confirmDialog({ title: `Remove ${del.size} ${del.size === 1 ? 'copy' : 'copies'}?`, message: 'Their bookmarks and highlights go with them.', confirmLabel: 'Remove', danger: true })) return;
      await lib.bulk([...del], 'remove'); toast(del.size + ' removed'); api.close(); done?.();
    } }, 'Remove selected');
    const upd = () => { btn.textContent = del.size ? `Remove ${del.size} selected` : 'Remove selected'; btn.disabled = !del.size; };
    groups.forEach((g) => {
      g.forEach((b, i) => { if (i > 0) del.add(b.id); });
      body.append(h('div', { class: 'dup-group' }, g.map((b) => {
        const row = h('button', { class: 'check-row' + (del.has(b.id) ? ' on' : ''), role: 'checkbox', 'aria-checked': del.has(b.id), onclick: () => {
          if (del.has(b.id)) del.delete(b.id); else del.add(b.id);
          row.classList.toggle('on', del.has(b.id)); row.setAttribute('aria-checked', del.has(b.id)); upd();
        } }, h('span', { class: 'box' }, icon('check', 14)),
        h('span', null, h('b', null, b.title), h('span', { class: 'row-hint', style: { display: 'block' } }, [b.author, lib.formatName(b), fmtBytes(b.size || 0), Math.round((b.progress || 0) * 100) + '% read'].filter(Boolean).join(' · '))));
        return row;
      })));
    });
    upd();
    return h('div', null, body, h('div', { class: 'dialog-actions' }, h('button', { class: 'btn ghost', onclick: () => api.close() }, 'Close'), btn));
  } });
}

export async function showStats() {
  const s = await stats.summary();
  const goalMin = +settings.get('reading.dailyGoal') || 0;
  const NS = 'http://www.w3.org/2000/svg';
  const ring = (frac) => {
    const R = 46, C = 2 * Math.PI * R;
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 110 110'); svg.setAttribute('class', 'goal-ring');
    const mk = (cls, dash) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', 55); c.setAttribute('cy', 55); c.setAttribute('r', R); c.setAttribute('class', cls); c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', 9); c.setAttribute('stroke-linecap', 'round'); if (dash != null) { c.setAttribute('stroke-dasharray', `${C} ${C}`); c.setAttribute('stroke-dashoffset', String(C * (1 - dash))); c.setAttribute('transform', 'rotate(-90 55 55)'); } return c; };
    svg.append(mk('goal-track'), mk('goal-fill', Math.min(1, frac)));
    return svg;
  };
  const todayMin = Math.floor(s.todaySeconds / 60);
  const goalCard = () => {
    const frac = goalMin ? s.todaySeconds / (goalMin * 60) : 0;
    const chips = segmented([{ value: '0', label: 'Off' }, { value: '10', label: '10' }, { value: '20', label: '20' }, { value: '30', label: '30' }, { value: '60', label: '60' }], String(goalMin), (v) => { settings.set('reading.dailyGoal', +v); toast(+v ? `Daily goal: ${v} min` : 'Daily goal off'); }, { label: 'Daily goal in minutes' });
    return h('div', { class: 'goal-card' },
      h('div', { class: 'goal-top' },
        h('div', { class: 'goal-ringwrap' }, ring(frac), h('div', { class: 'goal-center' }, h('b', null, String(todayMin)), h('span', null, goalMin ? `of ${goalMin} min` : 'min today'))),
        h('div', { class: 'goal-text' },
          h('div', { class: 'goal-streak' }, s.streak ? s.streak + (s.streak === 1 ? ' day streak' : ' day streak') : 'No streak yet'),
          h('div', { class: 'row-hint' }, goalMin ? (frac >= 1 ? 'Goal reached today. Lovely.' : `${Math.max(1, goalMin - todayMin)} min to go`) : 'Pick a daily goal to start a streak'))),
      chips);
  };
  const max = Math.max(60 * 10, ...s.days.map((d) => d.seconds));
  const week = h('div', { class: 'week-bars', role: 'img', 'aria-label': 'Reading time over the last seven days' },
    s.days.map((d) => h('div', { class: 'wk' + (d.today ? ' today' : '') + (goalMin && d.seconds >= goalMin * 60 ? ' hit' : '') },
      h('div', { class: 'wk-bar' }, h('i', { style: { height: Math.max(d.seconds ? 6 : 2, Math.round((d.seconds / max) * 100)) + '%' } })),
      h('span', null, d.dow.slice(0, 3)))));
  openSheet({
    title: 'Reading statistics', size: 'm',
    body: () => h('div', null,
      goalCard(), week,
      h('div', { class: 'stat-grid' },
        stat(fmtMinutes(s.totalSeconds / 60), 'Time reading'), stat(fmtMinutes(s.weekSeconds / 60), 'This week'),
        stat(String(s.completed), 'Finished'), stat(String(s.pagesRead), 'Pages turned'),
        stat(s.streak ? s.streak + (s.streak === 1 ? ' day' : ' days') : '—', 'Current streak'), stat(s.pace ? s.pace + ' / hour' : '—', 'Average pace')),
      h('p', { class: 'row-hint', style: { marginTop: '16px' } }, 'Kept on this device only. Your goal is a gentle target — no badges, no pressure.')),
  });
}
const stat = (v, l) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, l));

function showLicenses() {
  openSheet({
    title: 'Licenses', size: 'm',
    body: () => h('div', null,
      h('p', { class: 'row-hint' }, 'INK is built with the help of open-source software:'),
      h('div', { class: 'row' }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, 'PDF.js'), h('span', { class: 'row-hint' }, 'Mozilla Foundation · Apache License 2.0 · renders PDF pages and text')), null),
      h('div', { class: 'row' }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, 'libarchive.js (optional add-on)'), h('span', { class: 'row-hint' }, 'MIT licence · opens RAR-compressed comics when installed')), null),
      h('div', { class: 'row' }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, 'Newsreader · Inter · Lexend · Atkinson Hyperlegible'), h('span', { class: 'row-hint' }, 'Open-source typefaces (SIL OFL), loaded from Google Fonts when online')), null),
      h('p', { class: 'row-hint', style: { marginTop: '14px' } }, 'Full licence texts: see vendor-pdfjs-LICENSE.txt in the app files.')),
  });
}

function dictionaryGroup() {
  const status = h('span', { class: 'row-hint' }, 'Checking…');
  const refresh = async () => { const n = await dict.packSize(); status.textContent = n ? `${n.toLocaleString()} words on this device` : 'No dictionary file added yet'; };
  refresh();
  const input = h('input', { type: 'file', accept: '.json,.txt,.tsv,.csv,text/plain,application/json', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const f = input.files?.[0]; input.value = ''; if (!f) return;
    try { toast('Reading dictionary…'); const n = await dict.importPack(f); toast(`Added ${n.toLocaleString()} words`); } catch (e) { toast(e.message || 'Couldn’t read that file'); }
    refresh();
  });
  return group('Dictionary',
    h('p', { class: 'row-hint', style: { margin: '4px 0 10px' } }, 'Select a word while reading and tap Define. Add a dictionary file (JSON, or text with one “word, a tab, then the meaning” per line) to define words fully offline.'),
    status,
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '12px 0' } },
      h('button', { class: 'btn ghost', onclick: () => input.click() }, 'Add dictionary file'),
      h('button', { class: 'btn ghost', onclick: async () => { if (await confirmDialog({ title: 'Remove dictionary?', message: 'Words you looked up online stay saved.', confirmLabel: 'Remove' })) { await dict.clearPack(); refresh(); } } }, 'Remove'), input),
    toggleRow({ label: 'Allow online lookups', hint: 'Sends only the selected word to dictionaryapi.dev when it isn’t found offline. Results are saved for offline use.', value: S.get('app.dictOnline'), onChange: (v) => S.set('app.dictOnline', v) }));
}

function backupGroup(ctx) {
  const input = h('input', { type: 'file', accept: '.zip,application/zip', style: { display: 'none' } });
  const note = h('div', { class: 'row-hint' }, '');
  const bar = h('div', { class: 'progress-line', hidden: true }, h('i', { style: { width: '0%' } }));
  const prog = (f) => { bar.hidden = false; bar.firstChild.style.width = Math.round(f * 100) + '%'; };
  const done = () => setTimeout(() => { bar.hidden = true; }, 600);
  backup.estimate().then((e) => { note.textContent = `${e.books} book${e.books === 1 ? '' : 's'} · about ${fmtBytes(e.bytes)} of files`; });
  const make = async (includeBooks) => {
    try {
      toast('Preparing backup…');
      const r = await backup.createBackup({ includeBooks, onProgress: prog });
      backup.saveBlob(r.blob, r.name); done();
      toast(`Saved ${r.name}`);
    } catch (e) { done(); toast(e.message || 'Couldn’t create the backup'); }
  };
  input.addEventListener('change', async () => {
    const f = input.files?.[0]; input.value = ''; if (!f) return;
    try {
      toast('Restoring…');
      const r = await backup.restoreBackup(f, { onProgress: prog }); done();
      await lib.load();
      toast(`Restored: ${r.booksAdded} book${r.booksAdded === 1 ? '' : 's'} added, ${r.highlights} highlights, ${r.bookmarks} bookmarks`);
      if (r.skippedNoFile) setTimeout(() => toast(`${r.skippedNoFile} book${r.skippedNoFile === 1 ? ' is' : 's are'} not on this device — import ${r.skippedNoFile === 1 ? 'it' : 'them'} again and re-run the restore to bring back its notes`), 2600);
    } catch (e) { done(); toast(e.message || 'Couldn’t restore that file'); }
  });
  return group('Backup',
    h('p', { class: 'row-hint', style: { margin: '4px 0 10px' } }, 'INK keeps everything in this browser. A backup is a single file you can keep anywhere, and restore on this or another device.'),
    note,
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '12px 0' } },
      h('button', { class: 'btn primary', onclick: () => make(true) }, icon('download', 18), 'Back up everything'),
      h('button', { class: 'btn ghost', onclick: () => make(false) }, 'Notes & progress only'),
      h('button', { class: 'btn ghost', onclick: () => input.click() }, 'Restore'), input),
    bar,
    h('div', { class: 'row link', role: 'button', tabindex: '0', style: { cursor: 'pointer' }, onclick: async () => {
      const blob = await backup.exportAllAnnotations();
      if (!blob) { toast('No highlights or bookmarks yet'); return; }
      backup.saveBlob(blob, 'INK-highlights.md'); toast('Highlights exported');
    } }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, 'Export all highlights'), h('span', { class: 'row-hint' }, 'One Markdown file, grouped by book and chapter')), icon('chevR', 18)));
}
