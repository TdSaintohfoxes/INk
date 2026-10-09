/* INK — night reading: warm light, dimming, night schedule and sleep timer. Local only. */
import { h, icon } from './ink-util.js';
import * as settings from './ink-settings.js';
import { openSheet, slider, toggleRow, segmented, field, closeAllSheets } from './ink-ui.js';

const NIGHT_PRESET = { warm: 45, dim: 18 };
const toMin = (hhmm) => { const [a, b] = String(hhmm || '0:0').split(':').map(Number); return (a || 0) * 60 + (b || 0); };

function inWindow() {
  if (!settings.get('reading.nightAuto')) return false;
  const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
  const f = toMin(settings.get('reading.nightFrom')), t = toMin(settings.get('reading.nightTo'));
  return f <= t ? m >= f && m < t : m >= f || m < t;
}

/**
 * rd = reader root element, getCtl() = current engine controller, exit() = close the book, onToast(msg)
 * Returns { open(), destroy() }.
 */
export function mountNight(rd, { getCtl, exit, toast }) {
  const warmEl = h('div', { class: 'rd-warm', 'aria-hidden': 'true' });
  const dimEl = h('div', { class: 'rd-dim', 'aria-hidden': 'true' });
  rd.append(warmEl, dimEl);

  function apply() {
    const night = inWindow();
    const warm = Math.max(+settings.get('reading.warm') || 0, night ? NIGHT_PRESET.warm : 0);
    const dim = Math.max(+settings.get('reading.dim') || 0, night ? NIGHT_PRESET.dim : 0);
    warmEl.style.opacity = String(warm / 100);
    dimEl.style.opacity = String((dim / 100) * 0.7);
  }
  apply();
  const minuteT = setInterval(apply, 60000);
  const off = settings.on((k) => { if (/^reading\.(warm|dim|night)/.test(k)) apply(); });

  /* ---------- sleep timer ---------- */
  let sleepEnd = 0, sleepT = 0, sleepChapter = null, sleepMode = 'off', chapPoll = 0;
  function clearSleep() { clearTimeout(sleepT); clearInterval(chapPoll); sleepEnd = 0; sleepMode = 'off'; sleepChapter = null; }
  function setSleep(mode) {
    clearSleep();
    sleepMode = mode;
    if (mode === 'off') { toast('Sleep timer off'); return; }
    if (mode === 'chapter') {
      const ctl = getCtl();
      sleepChapter = ctl?.tocIndex?.() ?? null;
      chapPoll = setInterval(() => { const c = getCtl()?.tocIndex?.(); if (c != null && sleepChapter != null && c !== sleepChapter) { clearSleep(); sleepFired(); } }, 1500);
      toast('Sleep timer: end of chapter');
      return;
    }
    const mins = +mode;
    sleepEnd = Date.now() + mins * 60000;
    sleepT = setTimeout(() => { clearSleep(); sleepFired(); }, mins * 60000);
    toast(`Sleep timer: ${mins} min`);
  }
  let fireEl = null, fireT = 0;
  function sleepFired() {
    if (fireEl) return;
    let left = 30;
    const count = h('span', { class: 'sl-count' }, String(left));
    fireEl = h('div', { class: 'rd-sleep', role: 'alertdialog', 'aria-label': 'Sleep timer finished' },
      h('div', { class: 'rd-sleep-card' },
        h('div', { class: 'rd-sleep-ic' }, icon('moon', 26)),
        h('div', { class: 'rd-sleep-t' }, 'Time to rest'),
        h('div', { class: 'rd-sleep-s' }, 'Closing your book in ', count, ' s. Your place is saved.'),
        h('div', { class: 'rd-sleep-b' },
          h('button', { class: 'btn', onclick: () => { dismiss(); setSleep('15'); } }, 'Keep reading · 15 min'),
          h('button', { class: 'btn ghost', onclick: () => { dismiss(); exit(); } }, 'Close now'))));
    rd.append(fireEl);
    requestAnimationFrame(() => fireEl?.classList.add('on'));
    fireT = setInterval(() => { left--; count.textContent = String(Math.max(0, left)); if (left <= 0) { dismiss(); exit(); } }, 1000);
  }
  function dismiss() { clearInterval(fireT); fireEl?.remove(); fireEl = null; }

  function remaining() {
    if (sleepMode === 'chapter') return 'End of this chapter';
    if (sleepEnd) { const m = Math.max(1, Math.ceil((sleepEnd - Date.now()) / 60000)); return `${m} min left`; }
    return 'Off';
  }

  /* ---------- sheet ---------- */
  function open() {
    const ctl = getCtl();
    const opts = [{ value: 'off', label: 'Off' }, { value: '15', label: '15' }, { value: '30', label: '30' }, { value: '45', label: '45' }, { value: '60', label: '60' }];
    if (ctl?.tocIndex) opts.push({ value: 'chapter', label: 'Chapter' });
    const seg = segmented(opts, sleepMode === 'off' ? 'off' : sleepMode === 'chapter' ? 'chapter' : String([15, 30, 45, 60].find((m) => Math.abs(m * 60000 - (sleepEnd - Date.now())) < 60 * 60000 && m * 60000 >= sleepEnd - Date.now()) || '60'), (v) => { setSleep(v); status.textContent = remaining(); }, { label: 'Sleep timer (minutes)' });
    const status = h('div', { class: 'row-hint' }, remaining());
    const from = h('input', { type: 'time', class: 'night-time', value: settings.get('reading.nightFrom'), onchange: (e) => settings.set('reading.nightFrom', e.target.value || '21:00') });
    const to = h('input', { type: 'time', class: 'night-time', value: settings.get('reading.nightTo'), onchange: (e) => settings.set('reading.nightTo', e.target.value || '06:00') });
    openSheet({
      title: 'Night & sleep', size: 'm', className: 'rd-night-sheet',
      body: () => h('div', { class: 'night-body' },
        slider({ label: 'Warm light', min: 0, max: 100, step: 5, value: +settings.get('reading.warm') || 0, format: (v) => (v ? v + '%' : 'Off'), onInput: (v) => settings.set('reading.warm', v) }),
        slider({ label: 'Dim screen', min: 0, max: 80, step: 5, value: +settings.get('reading.dim') || 0, format: (v) => (v ? v + '%' : 'Off'), onInput: (v) => settings.set('reading.dim', v) }),
        toggleRow({ label: 'Night schedule', hint: 'Adds warm light and a little dimming automatically', value: !!settings.get('reading.nightAuto'), onChange: (v) => settings.set('reading.nightAuto', v) }),
        h('div', { class: 'night-times' }, h('label', null, h('span', null, 'From'), from), h('label', null, h('span', null, 'Until'), to)),
        field('Sleep timer', seg, null), status),
    });
  }

  return { open, destroy() { clearInterval(minuteT); clearSleep(); dismiss(); off?.(); warmEl.remove(); dimEl.remove(); } };
}
