/* INK — quiet reading statistics. Local only. No goals, no XP, no nagging. */
import * as db from './ink-db.js';
import { fmtDay } from './ink-util.js';
import * as settings from './ink-settings.js';

let sess = null;
let timer = 0;
let lastTouch = 0;
const IDLE_MS = 120000;
let goalListener = null, base = 0, notifiedDay = '';
export function onGoal(fn) { goalListener = fn; return () => { if (goalListener === fn) goalListener = null; }; }
async function loadBase(day) {
  try { base = (await db.allSessions()).filter((x) => x.day === day).reduce((n, x) => n + x.seconds, 0); } catch { base = 0; }
}

export function interaction() { lastTouch = Date.now(); }

export function begin(bookId) {
  end();
  lastTouch = Date.now();
  sess = { bookId, seconds: 0, pages: 0, flushedSeconds: 0, flushedPages: 0, day: fmtDay() };
  base = Infinity; loadBase(sess.day);
  timer = setInterval(() => {
    if (!sess) return;
    if (document.visibilityState === 'visible' && Date.now() - lastTouch < IDLE_MS) sess.seconds += 5;
    if (sess.seconds - sess.flushedSeconds >= 30) flush();
    const goal = (+settings.get('reading.dailyGoal') || 0) * 60;
    if (goal && base !== Infinity && base + sess.seconds >= goal && notifiedDay !== sess.day && (base + sess.seconds - 5) < goal + 60) { notifiedDay = sess.day; try { goalListener?.(); } catch { /* ignore */ } }
  }, 5000);
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVis);
}
function onVis() { if (document.visibilityState === 'hidden') flush(); }

export function pages(n = 1) { if (sess && n > 0) sess.pages += n; }

export function flush() {
  if (!sess) return Promise.resolve();
  const s = sess.seconds - sess.flushedSeconds, p = sess.pages - sess.flushedPages;
  if (s <= 0 && p <= 0) return Promise.resolve();
  sess.flushedSeconds = sess.seconds; sess.flushedPages = sess.pages;
  return db.addSession(sess.bookId, sess.day, s, p).catch(() => {});
}
export async function end() {
  clearInterval(timer);
  document.removeEventListener('visibilitychange', onVis);
  removeEventListener('pagehide', flush);
  const p = flush();
  sess = null;
  await p;
}

export async function summary() {
  const [sessions, books] = await Promise.all([db.allSessions(), db.listBooks()]);
  const today = fmtDay();
  const byDay = new Map();
  let total = 0, pagesRead = 0, paged = { s: 0, p: 0 };
  for (const s of sessions) {
    total += s.seconds; pagesRead += s.pages;
    byDay.set(s.day, (byDay.get(s.day) || 0) + s.seconds);
    paged.s += s.seconds; paged.p += s.pages;
  }
  const dayKey = (off) => { const d = new Date(); d.setDate(d.getDate() - off); return fmtDay(d); };
  let week = 0;
  for (let i = 0; i < 7; i++) week += byDay.get(dayKey(i)) || 0;
  // streak: consecutive days (>= 1 min) ending today – or yesterday, so a quiet morning doesn't read as a broken streak
  let streak = 0, i = (byDay.get(today) || 0) >= 60 ? 0 : 1;
  while ((byDay.get(dayKey(i)) || 0) >= 60) { streak++; i++; }
  const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push({ day: fmtDay(d), dow: d.toLocaleDateString(undefined, { weekday: 'short' }), seconds: byDay.get(fmtDay(d)) || 0, today: i === 0 }); }
  const pace = paged.s >= 600 && paged.p >= 5 ? Math.round((paged.p / paged.s) * 3600) : 0;
  return {
    totalSeconds: total, weekSeconds: week, todaySeconds: byDay.get(today) || 0,
    days, completed: books.filter((b) => b.dateFinished).length, pagesRead, streak, pace,
  };
}
