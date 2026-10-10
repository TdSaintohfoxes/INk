/* INK — reading ruler: a focus band that dims everything above and below it. Works in every reader. */
import { h, icon } from './ink-util.js';
import * as settings from './ink-settings.js';

const HEIGHTS = [52, 78, 120];

export function mountRuler(rd) {
  let y = 0.5;   // 0..1 of reader height
  const band = h('div', { class: 'rd-ruler', 'aria-hidden': 'true', hidden: true });
  const grip = h('button', { class: 'rd-ruler-grip', 'aria-label': 'Move reading ruler. Tap to change its height.', hidden: true }, icon('ruler', 22));
  rd.append(band, grip);

  const paint = () => {
    const on = !!settings.get('reading.ruler');
    band.hidden = grip.hidden = !on;
    if (!on) return;
    const H = HEIGHTS[Math.min(HEIGHTS.length - 1, Math.max(0, +settings.get('reading.rulerSize') || 1))];
    band.style.setProperty('--ry', (y * 100) + '%');
    band.style.setProperty('--rh', H + 'px');
    band.classList.toggle('light', settings.get('reading.theme') === 'light' || settings.get('reading.theme') === 'sepia');
    grip.style.top = (y * 100) + '%';
  };
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    drag = { moved: false, sy: e.clientY, y0: y };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = rd.getBoundingClientRect();
    if (Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
    y = Math.min(0.96, Math.max(0.04, drag.y0 + (e.clientY - drag.sy) / r.height));
    paint();
  });
  const end = () => {
    if (drag && !drag.moved) settings.set('reading.rulerSize', ((+settings.get('reading.rulerSize') || 1) + 1) % HEIGHTS.length);
    drag = null;
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', () => { drag = null; });
  for (const t of ['click', 'pointerup', 'touchend']) grip.addEventListener(t, (e) => e.stopPropagation());
  grip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { y = Math.max(0.04, y - 0.03); paint(); e.preventDefault(); }
    if (e.key === 'ArrowDown') { y = Math.min(0.96, y + 0.03); paint(); e.preventDefault(); }
  });
  paint();
  const off = settings.on((k) => { if (/^reading\.(ruler|rulerSize|theme)/.test(k)) paint(); });
  return { toggle: () => settings.set('reading.ruler', !settings.get('reading.ruler')), active: () => !!settings.get('reading.ruler'), destroy: () => { off(); band.remove(); grip.remove(); } };
}
