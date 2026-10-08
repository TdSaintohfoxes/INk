/* INK — shared UI pieces: toast, sheets, dialogs, form controls */
import { h, icon, $, clamp } from './ink-util.js';
import * as settings from './ink-settings.js';

const overlay = () => $('#overlay-root');

/* ---------------- toast ---------------- */
let toastEl, toastT;
export function toast(msg, opts = {}) {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    overlay().append(toastEl);
  }
  toastEl.replaceChildren(h('span', null, msg));
  if (opts.action) {
    toastEl.append(h('button', { class: 'toast-act', onclick: () => { opts.action.fn(); hideToast(); } }, opts.action.label));
  }
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(hideToast, opts.ms || (opts.action ? 6000 : 2800));
}
export function hideToast() { toastEl?.classList.remove('show'); }

/* ---------------- sheets (bottom sheet on phones, panel/modal on larger screens) ---------------- */
const stack = [];
let suppressPop = 0;

addEventListener('popstate', () => {
  if (suppressPop > 0) { suppressPop--; return; }
  const top = stack[stack.length - 1];
  if (top) top._close(true);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) { e.preventDefault(); e.stopPropagation(); stack[stack.length - 1].close(); }
}, true);

export function openSheet({ title, body, className = '', size = 'm', onClose, noHeader = false, kind = 'sheet' } = {}) {
  const prevFocus = document.activeElement;
  const scrim = h('div', { class: 'sheet-scrim' });
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => api.close() }, icon('close', 20));
  const head = noHeader ? null : h('header', { class: 'sheet-head' }, h('h2', { class: 'sheet-title' }, title || ''), closeBtn);
  const bodyEl = h('div', { class: 'sheet-body' });
  const sheet = h('section', { class: `sheet size-${size} ${kind} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' }, head, bodyEl);
  const layer = h('div', { class: 'sheet-layer' }, scrim, sheet);
  scrim.addEventListener('click', () => api.close());

  overlay().append(layer);
  history.pushState({ ink: 'sheet' }, '');
  requestAnimationFrame(() => layer.classList.add('open'));
  const f = sheet.querySelector('input,textarea,button:not(.icon-btn),[tabindex]') || closeBtn;
  setTimeout(() => f?.focus?.({ preventScroll: true }), 60);

  let closed = false;
  const api = {
    el: sheet, body: bodyEl, layer,
    setTitle: (t) => { const el = sheet.querySelector('.sheet-title'); if (el) el.textContent = t; },
    close: () => api._close(false),
    _close(fromPop) {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      if (!fromPop && history.state?.ink === 'sheet') { suppressPop++; history.back(); }
      layer.classList.remove('open');
      layer.classList.add('closing');
      const done = () => { layer.remove(); try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* gone */ } onClose?.(); };
      if (document.documentElement.dataset.motion === 'reduce') done(); else setTimeout(done, 220);
    },
  };
  stack.push(api);
  const content = typeof body === 'function' ? body(api) : body;
  if (content) bodyEl.append(content);
  const f2 = sheet.querySelector('input,textarea,button:not(.icon-btn),[tabindex]');
  if (f2 && !(f2 instanceof HTMLButtonElement)) setTimeout(() => f2.focus?.({ preventScroll: true }), 70);
  return api;
}
export const topSheet = () => stack[stack.length - 1] || null;
export const closeAllSheets = () => { [...stack].reverse().forEach((s) => s.close()); };

/* ---------------- dialogs ---------------- */
export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    openSheet({
      title, size: 's', kind: 'dialog', onClose: () => resolve(result),
      body: (api) => h('div', { class: 'dialog' },
        message ? h('p', { class: 'dialog-msg' }, message) : null,
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn ghost', onclick: () => api.close() }, cancelLabel),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { result = true; api.close(); } }, confirmLabel))),
    });
  });
}
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', type = 'text' }) {
  return new Promise((resolve) => {
    let result = null;
    openSheet({
      title, size: 's', kind: 'dialog', onClose: () => resolve(result),
      body: (api) => {
        const input = h('input', { class: 'input', type, value, placeholder, 'aria-label': label || title, autocomplete: 'off' });
        const submit = () => { result = input.value; api.close(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        return h('div', { class: 'dialog' }, label ? h('label', { class: 'field-label' }, label) : null, input,
          h('div', { class: 'dialog-actions' },
            h('button', { class: 'btn ghost', onclick: () => api.close() }, 'Cancel'),
            h('button', { class: 'btn primary', onclick: submit }, confirmLabel)));
      },
    });
  });
}
/** A list of actions in a sheet. items: [{label, icon, danger, hint, onClick}] */
export function actionSheet(title, items, opts = {}) {
  return openSheet({
    title, size: 's', className: 'actions', ...opts,
    body: (api) => h('div', { class: 'action-list' }, items.filter(Boolean).map((it) =>
      h('button', { class: 'action' + (it.danger ? ' danger' : ''), onclick: () => { api.close(); setTimeout(() => it.onClick?.(), 30); } },
        it.icon ? icon(it.icon, 20) : null, h('span', { class: 'action-label' }, it.label), it.hint ? h('span', { class: 'action-hint' }, it.hint) : null))),
  });
}

/* ---------------- form controls ---------------- */
export function segmented(options, value, onChange, { label, wrap = false } = {}) {
  const el = h('div', { class: 'seg' + (wrap ? ' wrap' : ''), role: 'radiogroup', 'aria-label': label || '' });
  const btns = options.map((o) => {
    const b = h('button', { type: 'button', role: 'radio', class: 'seg-btn', 'data-v': o.value, 'aria-checked': 'false', title: o.title || '',
      onclick: () => { set(o.value); onChange(o.value); } }, o.icon ? icon(o.icon, 18) : null, o.label ? h('span', null, o.label) : null);
    el.append(b);
    return b;
  });
  function set(v) { btns.forEach((b) => { const on = b.dataset.v === String(v); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }); }
  set(value);
  el.set = set;
  return el;
}
export function slider({ min, max, step = 1, value, format = (v) => v, onInput, label, ticks }) {
  const out = h('output', { class: 'slider-val' }, format(value));
  const input = h('input', { type: 'range', min, max, step, value, class: 'range', 'aria-label': label });
  input.addEventListener('input', () => { const v = parseFloat(input.value); out.textContent = format(v); onInput(v); });
  const dec = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Decrease ' + label, onclick: () => bump(-step) }, '−');
  const inc = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Increase ' + label, onclick: () => bump(step) }, '+');
  function bump(d) {
    const v = clamp(Math.round((parseFloat(input.value) + d) / step) * step, min, max);
    input.value = v; out.textContent = format(v); onInput(v);
  }
  const el = h('div', { class: 'slider' }, h('div', { class: 'slider-top' }, h('span', { class: 'field-label' }, label), out), h('div', { class: 'slider-row' }, dec, input, inc));
  el.set = (v) => { input.value = v; out.textContent = format(v); };
  return el;
}
export function toggleRow({ label, hint, value, onChange }) {
  const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: !!value, 'aria-label': label });
  input.addEventListener('change', () => onChange(input.checked));
  const row = h('label', { class: 'row toggle' }, h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, label), hint ? h('span', { class: 'row-hint' }, hint) : null), input);
  row.set = (v) => { input.checked = !!v; };
  return row;
}
export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), control, hint ? h('div', { class: 'row-hint' }, hint) : null);
}
export function group(title, ...children) {
  return h('section', { class: 'group' }, title ? h('h3', { class: 'group-title' }, title) : null, ...children);
}
export function swatches(items, value, onChange) {
  const el = h('div', { class: 'swatches', role: 'radiogroup' });
  const btns = items.map((it) => {
    const b = h('button', { type: 'button', role: 'radio', class: 'swatch', 'data-v': it.value, 'aria-label': it.label, 'aria-checked': 'false',
      style: { background: it.bg, color: it.fg }, onclick: () => { set(it.value); onChange(it.value); } }, h('span', { class: 'swatch-a' }, 'Aa'), h('span', { class: 'swatch-l' }, it.label));
    el.append(b); return b;
  });
  function set(v) { btns.forEach((b) => { const on = b.dataset.v === String(v); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }); }
  set(value);
  el.set = set;
  return el;
}

/* ---------------- error panel ---------------- */
export function errorView({ title = "INK couldn't open this file.", reason, actions = [] }) {
  return h('div', { class: 'error-view' },
    h('div', { class: 'error-ic' }, icon('warn', 34)),
    h('h2', null, title),
    reason ? h('p', null, reason) : null,
    h('div', { class: 'error-actions' }, actions.map((a) => h('button', { class: 'btn ' + (a.kind || 'ghost'), onclick: a.onClick }, a.label))));
}

export function motionOK() { return !settings.motionReduced(); }
