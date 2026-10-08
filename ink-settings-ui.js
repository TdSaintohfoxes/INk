/* INK — Settings (Appearance · Reading · Library · Storage · Accessibility · About) and reading statistics */
import { h, icon, fmtBytes, fmtMinutes } from './ink-util.js';
import * as settings from './ink-settings.js';
import * as db from './ink-db.js';
import * as lib from './ink-lib.js';
import * as stats from './ink-stats.js';
import { openSheet, segmented, slider, toggleRow, field, group, swatches, toast, confirmDialog } from './ink-ui.js';

const S = settings;

export function renderSettings(root, ctx) {
  const inner = h('div', { class: 'view-inner view-in' });
  root.replaceChildren(inner);
  inner.append(
    h('header', { class: 'top' }, h('span', { class: 'wordmark small' }, 'INK')),
    h('h1', { class: 'page-title', style: { marginBottom: '8px' } }, 'Settings'),
    h('button', { class: 'row link', onclick: showStats }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, 'Reading statistics'), h('span', { class: 'row-hint' }, 'Time, books finished, pace — private to this device')), icon('chevR', 18)),

    group('Appearance',
      field('App theme', segmented([{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'oled', label: 'OLED' }], S.get('app.theme'), (v) => S.set('app.theme', v))),
      readingThemeField(),
      toggleRow({ label: 'Animations', hint: 'Page and screen transitions', value: S.get('app.animations'), onChange: (v) => S.set('app.animations', v) })),

    group('Reading',
      field('Page behavior', segmented([{ value: 'paged', label: 'Pages', icon: 'single' }, { value: 'scroll', label: 'Scroll', icon: 'scroll' }], S.get('reading.flow'), (v) => S.set('reading.flow', v)), 'For EPUB. You can also change it while reading.'),
      field('Default font', segmented([{ value: 'serif', label: 'Serif' }, { value: 'sans', label: 'Sans' }, { value: 'humanist', label: 'Humanist' }, { value: 'mono', label: 'Mono' }], S.get('reading.font'), (v) => S.set('reading.font', v), { wrap: true })),
      slider({ label: 'Default margins', min: 4, max: 80, step: 2, value: S.get('reading.margin'), format: (v) => v + ' px', onInput: (v) => S.set('reading.margin', v) }),
      field('Default reading direction', segmented([{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left (manga)' }], S.get('reading.direction'), (v) => S.set('reading.direction', v)), 'Used for comics unless the file says otherwise.'),
      toggleRow({ label: 'Auto-hide controls', hint: 'Controls fade away while you read', value: S.get('reading.autoHide'), onChange: (v) => S.set('reading.autoHide', v) }),
      toggleRow({ label: 'Tap edges to turn pages', value: S.get('reading.tapNav'), onChange: (v) => S.set('reading.tapNav', v) })),

    group('Library',
      field('Sort order', segmented(lib.SORTS.slice(0, 3).map(([value, label]) => ({ value, label: label.replace('Recently ', '') })), S.get('library.sort'), (v) => { S.set('library.sort', v); S.set('library.sortDir', lib.defaultDir(v)); }), 'More options in the library toolbar.'),
      field('Grid size', segmented([{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'Large' }], S.get('library.gridSize'), (v) => S.set('library.gridSize', v))),
      toggleRow({ label: 'Group series automatically', hint: 'Volumes with matching names are stacked. You can always fix a book by hand.', value: S.get('library.group'), onChange: (v) => S.set('library.group', v) }),
      toggleRow({ label: 'Progress on covers', value: S.get('library.showProgress'), onChange: (v) => S.set('library.showProgress', v) })),

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

function readingThemeField() {
  const items = [{ value: 'auto', label: 'Auto', bg: 'linear-gradient(135deg,#f8f6f0 50%,#1e1e21 50%)', fg: '#888' }]
    .concat(Object.entries(S.READING_THEMES).map(([value, t]) => ({ value, label: t.name, bg: t.bg, fg: t.fg })))
    .concat([{ value: 'custom', label: 'Custom', bg: S.get('reading.customBg'), fg: S.get('reading.customFg') }]);
  const custom = h('div', { style: { display: S.get('reading.theme') === 'custom' ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' } },
    colorField('Background', 'reading.customBg'), colorField('Text', 'reading.customFg'));
  const sw = swatches(items, S.get('reading.theme'), (v) => { S.set('reading.theme', v); custom.style.display = v === 'custom' ? 'grid' : 'none'; });
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Reading theme'), sw, custom,
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
      h('button', { class: 'btn ghost', onclick: async () => { toast('Rebuilding covers…'); await ctx.rebuildCovers(); toast('Covers rebuilt'); } }, 'Rebuild covers')));
}

export async function showStats() {
  const s = await stats.summary();
  openSheet({
    title: 'Reading statistics', size: 'm',
    body: () => h('div', null,
      h('div', { class: 'stat-grid' },
        stat(fmtMinutes(s.totalSeconds / 60), 'Time reading'), stat(fmtMinutes(s.weekSeconds / 60), 'This week'),
        stat(String(s.completed), 'Finished'), stat(String(s.pagesRead), 'Pages turned'),
        stat(s.streak ? s.streak + (s.streak === 1 ? ' day' : ' days') : '—', 'Current streak'), stat(s.pace ? s.pace + ' / hour' : '—', 'Average pace')),
      h('p', { class: 'row-hint', style: { marginTop: '16px' } }, 'Kept on this device only. No goals, no badges — it is here if you are curious.')),
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
