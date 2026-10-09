/* INK — floating toolbar shown over a text selection: highlight colours, note, copy */
import { h, icon } from './ink-util.js';
import { HL_COLORS } from './ink-reader.js';

/**
 * show({ host, rect, current, onColor(color), onNote(), onCopy(), onRemove?() }) → close()
 * rect is a DOMRect in viewport coordinates; host is the positioned container.
 */
export function showSelBar({ host, rect, current, onColor, onNote, onCopy, onRemove, onDefine }) {
  const hb = host.getBoundingClientRect();
  const bar = h('div', { class: 'sel-bar', role: 'toolbar', 'aria-label': 'Selection' },
    ...Object.entries(HL_COLORS).map(([name, c]) => h('button', { 'aria-label': 'Highlight ' + name, onclick: () => onColor(name) }, h('span', { class: 'dot' + (current === name ? ' on' : ''), style: { '--c': c } }))),
    h('span', { class: 'sel-sep' }),
    onDefine ? h('button', { 'aria-label': 'Define word', onclick: onDefine }, 'Define') : null,
    onNote ? h('button', { 'aria-label': 'Add note', onclick: onNote }, icon('note', 18)) : null,
    h('button', { 'aria-label': 'Copy', onclick: onCopy }, 'Copy'),
    onRemove ? h('button', { 'aria-label': 'Remove highlight', onclick: onRemove }, icon('trash', 18)) : null);
  host.append(bar);
  const w = bar.offsetWidth, hh = bar.offsetHeight;
  let x = rect.left + rect.width / 2 - hb.left, y = rect.top - hb.top - 10;
  let flip = false;
  if (y - hh < 70) { y = rect.bottom - hb.top + hh + 14; flip = true; }
  x = Math.max(w / 2 + 8, Math.min(hb.width - w / 2 - 8, x));
  bar.style.left = x + 'px'; bar.style.top = y + 'px';
  if (flip) bar.style.transform = 'translate(-50%, -100%)';
  return () => bar.remove();
}
