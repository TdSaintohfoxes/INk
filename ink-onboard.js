/* INK — first run: short, no account, no tutorial */
import { h } from './ink-util.js';
import * as db from './ink-db.js';
import { $ } from './ink-util.js';

export function showOnboarding({ pickFiles }) {
  return new Promise((resolve) => {
    const root = h('div', { class: 'onboard', role: 'dialog', 'aria-label': 'Welcome to INK' });
    const finish = async () => { await db.kvSet('onboarded', true); root.remove(); resolve(); };
    const step1 = () => root.replaceChildren(h('div', { class: 'step' },
      h('div', { class: 'wordmark' }, 'INK'),
      h('h1', null, 'Your library.', h('span', null, 'Your books.'), h('span', null, 'Your way.')),
      h('button', { class: 'btn primary', onclick: step2 }, 'Get Started')));
    const step2 = () => root.replaceChildren(h('div', { class: 'step' },
      h('div', { class: 'wordmark' }, 'INK'),
      h('h1', null, 'Import your first book'),
      h('p', null, 'Everything stays on this device.'),
      h('div', { class: 'fmts' }, 'EPUB · PDF · CBR · CBZ'),
      h('button', { class: 'btn primary', onclick: async () => { await finish(); pickFiles(); } }, 'Import'),
      h('button', { class: 'skip', onclick: finish }, 'Not now')));
    step1();
    $('#overlay-root').append(root);
  });
}
