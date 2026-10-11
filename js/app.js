/* Commit — accountability app (mock, no backend). All data lives in localStorage. */
'use strict';

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = ms => new Promise(res => setTimeout(res, ms));
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = n => '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Economics: a stake below the minimum is not worth the payment fees; a ticket costs half the minimum stake.
const MIN_STAKE = 10, TICKET_PRICE = 0.5;
const TICKET_PACKS = [1, 3, 5];
const RETRIES_PER_MONTH = 4, RETRY_PRICE = 0.25;
// Pack prices in dollars. Bigger packs cost less per item, and a retry costs half as much as a ticket.
const PACK_PRICES = { bail: { 1: 0.5, 3: 1, 5: 1.5 }, retry: { 1: 0.25, 3: 0.5, 5: 0.75 } };
const packCost = (n, kind) => PACK_PRICES[kind][n];
const RETRY_PACKS = [1, 3, 5];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;                       // more than a day away: minutes and seconds are noise
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
// A deadline in plain words: "6:40 PM", "Tomorrow, 6:40 PM", "Fri 6:40 PM", "Oct 14, 6:40 PM".
function fmtDeadline(ts, now = Date.now()) {
  const day = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const diff = Math.round((day(ts) - day(now)) / 86400000);
  const time = fmtClock(ts);
  if (diff <= 0) return time;
  if (diff === 1) return `Tomorrow, ${time}`;
  if (diff < 7) return `${new Date(ts).toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
// "3 days 4 hours", "2 h 15 min", "40 min"
function humanSpan(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d) return `${d} day${d > 1 ? 's' : ''}${h ? ` ${h} hour${h > 1 ? 's' : ''}` : ''}`;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  return `${m} min`;
}
function timeAgo(ts) {
  const d = Date.now() - ts, m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

/* ---------- motion helpers ---------- */
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Countdown text as per-character spans so a changed digit can roll in on its own.
const digitsHTML = text => Array.from(text).map((c, i) => `<span class="dg in" style="--d:${i * 18}ms">${c}</span>`).join('');
function setCountdown(el, text) {
  const cur = el.children;
  if (cur.length !== text.length) { el.innerHTML = digitsHTML(text).replace(/ in"/g, ' in t"'); return; }
  Array.from(text).forEach((c, i) => {
    if (cur[i].textContent === c) return;
    const n = document.createElement('span');
    n.className = 'dg in t';
    n.textContent = c;
    cur[i].replaceWith(n);
  });
}

// Count a figure up from zero when its screen opens.
function countUp(el, to, fmt = String, ms = 450) {
  if (reduceMotion()) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / ms);
    el.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const roundMoney = n => fmtMoney(Math.round(n * 100) / 100);

function playRecordCounters() {
  const st = historyStats();
  countUp($('#hero-balance'), state.balance, roundMoney, 500);
  countUp($('#stat-completed'), st.done, n => Math.round(n));
  countUp($('#stat-missed'), st.missed, n => Math.round(n));
  countUp($('#stat-sent'), state.totalSent, roundMoney);
}

function flash(kind) {
  if (reduceMotion()) return;
  const f = document.createElement('div');
  f.className = 'flash' + (kind ? ' ' + kind : '');
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 900);
}

/* ---------- state ---------- */
const LS_STATE = 'commit_state_v1', LS_USER = 'commit_user_v1', LS_USERS = 'commit_users_v1', LS_SESSION = 'commit_session_v1', LS_ONBOARDED = 'commit_onboarded_v1';
let state = null;
let currentUser = null;

/* ---------- optional backend (js/api.js) ----------
   Off unless ?api=1. Then the server owns the data: every action is sent to it, and `state` is replaced by what it answers. */
const HTTP = API.on;

// A retry length picked on an offer card but not yet accepted lives only here, so keep it across a refresh from the server.
function applyServer(s) {
  const picked = {};
  if (state) state.tasks.forEach(t => { if (t.status === 'offer' && t.offerChoiceMs) picked[t.id] = t.offerChoiceMs; });
  state = s;
  state.tasks.forEach(t => { if (picked[t.id] && t.status === 'offer' && retryChoices(t).includes(picked[t.id])) t.offerChoiceMs = picked[t.id]; });
}

function apiFailure(e) {
  if (e instanceof API.ApiError && e.status === 401) { toast('Signed out. Sign in again', 'error'); setTimeout(() => location.reload(), 900); return; }
  toast(e instanceof API.ApiError ? e.message : 'Something went wrong', 'error');
}

// Runs one server action, swaps in the state it returns and redraws. Resolves to the answer, or null after showing the error.
// One action at a time: these move money, so a double tap must not send twice.
let acting = false, mutations = 0;
async function act(call) {
  if (acting) return null;
  acting = true; mutations++;
  try { const r = await call(); applyServer(r.state); renderAll(); return r; }
  catch (e) { apiFailure(e); return null; }
  finally { acting = false; }
}

// Pulls fresh state (the server settles missed deadlines) and redraws only if something changed.
let lastSync = 0, syncBusy = false;
async function syncSoon(minGap = 3000) {
  if (!HTTP || !currentUser || syncBusy || acting || Date.now() - lastSync < minGap) return;
  syncBusy = true; lastSync = Date.now();
  try {
    const before = new Map(state.tasks.map(t => [t.id, t.status]));
    const sig = s => JSON.stringify([s.balance, s.spendable, s.tickets, s.extraRetries, s.tasks.map(t => [t.id, t.status, t.deadline, t.attempt])]);
    const was = sig(state), seen = mutations;
    const next = await API.sync();
    if (acting || mutations !== seen) return;                        // an action finished meanwhile: this answer is older than the state it returned
    if (sig(next) === was) return;
    applyServer(next);
    renderAll();
    next.tasks.forEach(t => {                                        // tell the person what happened while they were away
      const prev = before.get(t.id);
      if (prev === 'active' && t.status === 'offer') { flash('try'); toast('Missed. One more try?', 'try'); }
      else if ((prev === 'active' || prev === 'offer') && t.status === 'failed') { flash(); toast(`Missed "${t.name}". ${fmtMoney(t.charged || 0)} to ${(state.charities.find(c => c.id === t.charityId) || {}).name || 'charity'}`, 'warn'); }
    });
  } catch (e) { if (e instanceof API.ApiError && e.status === 401) apiFailure(e); }
  finally { syncBusy = false; }
}

// Every account keeps its own data under its own key, so several people can use one browser.
const keyFor = (base, u = currentUser && currentUser.username) => `${base}:${u}`;
function loadState(u) { try { const raw = localStorage.getItem(keyFor(LS_STATE, u)); if (raw) return JSON.parse(raw); } catch (e) {} return null; }
function saveState() {
  if (!currentUser || HTTP) return;                  // with the backend, the server is the only copy
  try { localStorage.setItem(keyFor(LS_STATE), JSON.stringify(state)); }
  catch (e) { toast('Storage is full', 'error'); }
}
// The demo account keeps its sample tasks; every other account starts clean.
const newStateFor = u => (u === 'demo' ? MOCK.seedState() : MOCK.freshState());
// Saves from older versions lack the newer charity fields and charities. Fill them in without touching the user's numbers.
function normalizeState(st) {
  MOCK.charities().forEach(base => {
    const c = st.charities.find(x => x.id === base.id);
    if (!c) st.charities.push(base);
    else ['category', 'goal', 'impact'].forEach(k => { if (c[k] === undefined) c[k] = base[k]; });
  });
  if (!Number.isInteger(st.tickets) || st.tickets < 0) st.tickets = 0;
  if (!Number.isInteger(st.extraRetries) || st.extraRetries < 0) st.extraRetries = 0;   // bought retries; they do not expire
  if (!st.retries || typeof st.retries.used !== 'number') st.retries = { month: '', used: 0 };
  st.defaultPenalty = Math.max(MIN_STAKE, st.defaultPenalty || 0);   // tasks already running keep the stake they were made with
  st.tasks.forEach(t => { if (t.status === 'failed' && !t.charityId) t.charityId = st.selectedCharityId; });
  return st;
}
function initState(u) {
  let saved = loadState(u);
  if (u === 'demo' && saved && saved.seedVersion !== MOCK.SEED_VERSION) saved = null;   // the demo's starting numbers changed: start it over
  state = normalizeState(saved || newStateFor(u));
  saveState();
}
const taskById = id => state.tasks.find(t => t.id === id);
const selectedCharity = () => state.charities.find(c => c.id === state.selectedCharityId) || state.charities[0];

function isMobile() {
  if (MOCK_CAMERA) return true;   // the phone frame (or ?mockcam) stands in for a phone, so completing is allowed there
  return /Mobi|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 900);
}
// Inside the phone.html frame (or with ?mockcam) the camera is mocked: a predefined photo stands in for the viewfinder.
const MOCK_CAMERA = window.top !== window || /[?&]mockcam\b/.test(location.search);
const SNAP_WORDS = [
  [/gym|workout|lift|weights?|exercise/i, '🏋️'], [/run|jog/i, '🏃'], [/cook|dinner|lunch|breakfast|meal/i, '🍳'],
  [/clean|tidy|vacuum|laundry|home|room/i, '🧹'], [/read|book|study|learn/i, '📚'], [/work|code|app|laptop|write/i, '💻'],
  [/yoga|stretch|meditat/i, '🧘']
];
function mockSnapFor(t) {
  const icon = (t.icon || '').replace(/\uFE0F/g, '');
  const key = Object.keys(MOCK.SNAPS).find(k => k.replace(/\uFE0F/g, '') === icon)
    || (SNAP_WORDS.find(([re]) => re.test(t.name)) || [])[1];
  const pool = MOCK.SNAPS[key] || (() => {   // unknown task: stable pick by name, not one photo for all
    const all = Object.values(MOCK.SNAPS).flat();
    return [all[[...(t.name || '')].reduce((h, c) => h + c.charCodeAt(0), 0) % all.length]];
  })();
  return `img/proof/${pool[Math.floor(Math.random() * pool.length)]}.jpg`;
}

// Handheld-camera wobble for the mock viewfinder: layered sines, slightly zoomed so edges never show.
let mockShakeRaf = 0;
function startMockShake() {
  const view = $('#pf-mock-view');
  const t0 = performance.now();
  cancelAnimationFrame(mockShakeRaf);
  const tick = now => {
    const t = (now - t0) / 1000;
    const x = 5 * Math.sin(t * 1.3) + 2.5 * Math.sin(t * 3.1 + 1) + 1 * Math.sin(t * 7.3);
    const y = 4 * Math.sin(t * 1.7 + 2) + 2 * Math.sin(t * 3.7) + 0.8 * Math.sin(t * 8.1 + 1);
    const r = 0.5 * Math.sin(t * 1.1 + 0.5) + 0.25 * Math.sin(t * 2.9);
    view.style.transform = `translate(${x}px,${y}px) rotate(${r}deg) scale(1.1)`;
    mockShakeRaf = requestAnimationFrame(tick);
  };
  mockShakeRaf = requestAnimationFrame(tick);
}
const hasCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

/* ---------- theme: auto (follows the device), light or dark ---------- */
const LS_THEME = 'commit_theme';
const THEME_COLOR = { light: '#f6f7f6', dark: '#0b0e0c' };
function themeChoice() { const t = localStorage.getItem(LS_THEME); return t === 'light' || t === 'dark' ? t : 'auto'; }
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'auto') { root.removeAttribute('data-theme'); localStorage.removeItem(LS_THEME); }
  else { root.setAttribute('data-theme', choice); localStorage.setItem(LS_THEME, choice); }
  // browser chrome colour follows the chosen theme (or the device, in auto)
  const mode = choice === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice;
  $$('meta[name="theme-color"]').forEach(m => m.setAttribute('content', THEME_COLOR[mode]));
  $$('#theme-choice .seg-btn').forEach(b => { const on = b.dataset.themeChoice === choice; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
}

/* ---------- toasts ---------- */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 320); }, 3400);
}

/* ---------- auth (mock) ---------- */
const DEMO_USERS = { demo: { password: 'demo123', name: 'Demo' } };
function getUsers() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(LS_USERS)) || {}; } catch (e) {}
  return { ...stored, ...DEMO_USERS };
}

// Older versions kept one account in one place. Move it across so nobody loses their data.
function migrateLegacy() {
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LS_USER)); } catch (e) {}
  if (!legacy || !legacy.username) return;
  const u = String(legacy.username).trim().toLowerCase();
  const users = getUsers();
  if (!users[u]) {
    const stored = JSON.parse(localStorage.getItem(LS_USERS) || '{}');
    stored[u] = { password: legacy.password, name: String(legacy.username).trim() };
    localStorage.setItem(LS_USERS, JSON.stringify(stored));
  }
  const oldState = localStorage.getItem(LS_STATE);
  if (oldState && !localStorage.getItem(keyFor(LS_STATE, u))) localStorage.setItem(keyFor(LS_STATE, u), oldState);
  localStorage.setItem(keyFor(LS_ONBOARDED, u), '1');           // existing users skip the setup
  if (localStorage.getItem(LS_SESSION)) localStorage.setItem(LS_SESSION, u);
  localStorage.removeItem(LS_USER);
  localStorage.removeItem(LS_STATE);
}

const cap = str => str.charAt(0).toUpperCase() + str.slice(1);
const USERNAME_RE = /^[a-z0-9._-]{2,20}$/;

// Starts a session for an existing account. `registered` means they just created it, so setup follows straight away.
function startSession(u, opts = {}) {
  const user = getUsers()[u] || {};
  currentUser = { username: u, name: user.name || cap(u) };
  localStorage.setItem(LS_SESSION, u);
  initState(u);
  if (u === 'demo') localStorage.setItem(keyFor(LS_ONBOARDED), '1');     // the demo account skips setup
  enterApp(opts);
}

// A session the server has already opened: `s` is its state.
function startServerSession(s, opts = {}) {
  currentUser = { username: s.user.username, name: s.user.name };
  applyServer(s);
  enterApp(opts);
}

// Sign in only. A username that does not exist is an error, with an offer to create it.
async function handleLogin(rawName, password) {
  if (HTTP) {
    try { startServerSession((await API.login(rawName.trim(), password)).state); return null; }
    catch (e) { return { message: e.message, signup: e.code === 'NO_SUCH_USER' }; }
  }
  const u = rawName.trim().toLowerCase();
  const user = getUsers()[u];
  if (!user) return { message: 'No account with that username', signup: true };
  if (user.password !== password) return { message: 'Wrong password' };
  startSession(u);
  return null;
}

/* ---------- registration ---------- */
// 0 too short, 1 weak, 2 okay, 3 strong
function passwordStrength(pw) {
  if (pw.length < 6) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (pw.length >= 12 || (pw.length >= 10 && classes >= 3)) return 3;
  if (pw.length >= 8 && classes >= 2) return 2;
  return 1;
}

// Returns { name?, username?, password?, confirm? } with a message for each problem; empty means valid.
function validateRegistration(v) {
  const e = {};
  const name = (v.name || '').trim(), u = (v.username || '').trim().toLowerCase();
  if (!name) e.name = 'Enter your name';
  else if (name.length > 30) e.name = '30 characters or fewer';
  if (!u) e.username = 'Choose a username';
  else if (!USERNAME_RE.test(u)) e.username = '2 to 20 letters or numbers';
  else if (getUsers()[u]) e.username = 'Username taken';
  if ((v.password || '').length < 6) e.password = 'At least 6 characters';
  else if (v.password.toLowerCase() === u) e.password = 'Cannot match your username';
  if (!v.confirm) e.confirm = 'Repeat your password';
  else if (v.confirm !== v.password) e.confirm = 'Does not match';
  return e;
}

// Creates the account and signs in. Returns null on success, or the validation errors.
async function registerAccount(v) {
  const errors = validateRegistration(v);
  if (Object.keys(errors).length) return errors;
  if (HTTP) {
    try { startServerSession((await API.register(v)).state, { registered: true }); return null; }
    catch (e) { return e.details && typeof e.details === 'object' ? e.details : { username: e.message }; }
  }
  const u = v.username.trim().toLowerCase();
  const stored = JSON.parse(localStorage.getItem(LS_USERS) || '{}');
  stored[u] = { password: v.password, name: v.name.trim(), createdAt: Date.now() };
  localStorage.setItem(LS_USERS, JSON.stringify(stored));
  startSession(u, { registered: true });
  return null;
}

function logout() {
  if (HTTP) { API.logout().catch(() => {}).finally(() => location.reload()); return; }
  localStorage.removeItem(LS_SESSION);
  location.reload();
}

/* ---------- app shell / navigation ---------- */
function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  const target = $('#view-' + name);
  if (target) target.classList.remove('hidden');
  $$('[data-view]').forEach(b => {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    if (b.classList.contains('nav-item') || b.classList.contains('bn-item')) on ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });
  $('#tasks-active-list').classList.remove('still');
  document.body.dataset.view = name;
  if (state) renderOfferBanner();
  if (name === 'record' && state) playRecordCounters();
}

function enterApp(opts = {}) {
  const name = currentUser.name;
  $('#view-login').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#side-username').textContent = name;
  $('#side-avatar').textContent = name.charAt(0).toUpperCase() || 'A';
  $('#set-avatar').textContent = name.charAt(0).toUpperCase() || 'A';
  renderAll();
  showView('home');
  // accounts that have not done the setup get the questions; a brand new account gets them immediately
  if (!(HTTP ? state.onboarded : localStorage.getItem(keyFor(LS_ONBOARDED)))) {
    if (opts.registered) ONBOARDING.open({ registered: true });
    else setTimeout(() => ONBOARDING.open(), 400);
  }
}

function renderAll() { renderHome(); renderRecord(); renderCharities(); renderSettings(); renderShop(); updateTopbarBalance(); }

/* ---------- today: live timers only ---------- */
const RING_LONG = 5; // countdown strings longer than "mm:ss" get a smaller ring numeral
function taskCardHTML(t, lead) {
  const remaining = t.deadline - Date.now();
  const pct = Math.max(0, Math.min(100, (remaining / t.durationMs) * 100));
  const text = fmtCountdown(remaining);
  const complete = `<button class="btn primary complete-btn" data-complete="${t.id}">Complete</button>`;
  const help = ASSIST.kindOf(t) ? `<button class="btn ghost help-btn" data-help="${t.id}">Help</button>` : '';
  const bail = (t.attempt || 1) === 2 ? '' : `<button class="btn ghost bail-btn" data-bail="${t.id}">Bail out</button>`;
  const btn = `<div class="card-actions">${complete}${help}${bail}</div>`;
  const retryClass = (t.attempt || 1) === 2 ? ' retry' : '';
  const retryChip = (t.attempt || 1) === 2 ? '<span class="chip stake retry">One more try</span>' : '';
  const countdown = `<span class="countdown" data-countdown="${t.id}" aria-label="${text} remaining">${digitsHTML(text)}</span>`;

  if (!lead) {
    return `<article class="task-card${retryClass}" data-task-id="${t.id}">
      <div class="task-head">
        <div class="task-title"><h3>${esc(t.name)}</h3><span class="chip stake">${fmtMoney(t.penalty)}</span>${retryChip}</div>
      </div>
      <div class="timer-block">
        <div class="timer-row">${countdown}<span class="deadline-label">${fmtDeadline(t.deadline)}</span></div>
        <div class="progress"><div class="progress-fill" data-progress="${t.id}" style="width:${pct}%"></div></div>
      </div>
      ${btn}
    </article>`;
  }

  return `<article class="task-card lead${text.length > RING_LONG ? ' long' : ''}${retryClass}" data-task-id="${t.id}">
    <div class="lead-body">
      <div class="ring-wrap">
        <svg viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="rg-${t.id}" class="ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0"/><stop offset="1"/></linearGradient></defs><circle class="ring-bg" cx="60" cy="60" r="54"/><circle class="ring-fg" cx="60" cy="60" r="54" pathLength="100" stroke="url(#rg-${t.id})" data-ring="${t.id}" style="stroke-dashoffset:${(100 - pct).toFixed(2)}"/></svg>
        <div class="ring-center">${countdown}</div>
      </div>
      <div class="lead-info">
        <div class="task-head">
          <div class="task-title"><h3>${esc(t.name)}</h3>${retryChip}</div>
        </div>
        <dl class="fact-list">
          <div class="fact"><dt>Stake</dt><dd>${fmtMoney(t.penalty)}</dd></div>
          <div class="fact"><dt>Due</dt><dd>${fmtDeadline(t.deadline)}</dd></div>
        </dl>
        ${btn}
      </div>
    </div>
  </article>`;
}

// What onboarding learned about this person, used to rank venues. Empty until they have answered.
const prefsFromProfile = () => (state && state.profile ? { when: state.profile.when, blocker: state.profile.blocker } : {});

/* ---------- recommended tasks ---------- */
const RECOMMENDED = [
  { name: 'Gym visit',       icon: '🏋️', h: 2, m: 0,  stake: 10 },
  { name: 'Morning run',     icon: '🏃', h: 1, m: 0,  stake: 10 },
  { name: 'Study session',   icon: '📚', h: 1, m: 0,  stake: 10 },
  { name: 'Deep work block', icon: '💻', h: 2, m: 0,  stake: 10 },
  { name: 'Cook dinner',     icon: '🍳', h: 1, m: 0,  stake: 10 },
  { name: 'Tidy the room',   icon: '🧹', h: 0, m: 30, stake: 10 },
  { name: 'Yoga or stretch', icon: '🧘', h: 0, m: 30, stake: 10 },
  { name: 'Water the plants', icon: '🌿', h: 0, m: 30, stake: 10 }
];

function recommendedTasks() {
  const active = state.tasks.filter(t => t.status === 'active');
  const runningNames = new Set(active.map(t => t.name.trim().toLowerCase()));
  const runningIcons = new Set(active.map(t => t.icon));
  const doneBefore = icon => state.tasks.filter(t => t.status === 'completed' && t.icon === icon).length;
  return RECOMMENDED
    .filter(r => !runningNames.has(r.name.toLowerCase()) && !runningIcons.has(r.icon))
    .map((r, i) => ({ r, i, n: doneBefore(r.icon) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)            // things you have finished before come first
    .map(({ r, n }) => ({ ...r, why: n ? `You have finished this ${n} time${n > 1 ? 's' : ''}.` : r.why }));
}

let recoToken = 0;
function renderRecommended() {
  const list = recommendedTasks().slice(0, 7);
  $('#reco-title').classList.toggle('hidden', !list.length);
  $('#recommended').innerHTML = list.map((r, i) => `
    <article class="reco" style="--i:${i + 2}">
      <div class="reco-top">
        <div class="reco-icon" aria-hidden="true">${r.icon}</div>
        <div><h3>${esc(r.name)}</h3></div>
      </div>
      <div class="reco-meta">
        <div><b>${r.h ? r.h + 'h' : ''}${r.m ? (r.h ? ' ' : '') + r.m + 'm' : ''}</b></div>
        <div><b>${fmtMoney(r.stake)}</b></div>
      </div>
      <div class="reco-where" data-where="${i}"></div>
      <button class="btn ghost sm" data-reco="${esc(r.name)}">Start</button>
    </article>`).join('');

  // venues load after the cards appear, so a slow data source never blocks the screen
  const token = ++recoToken;
  Promise.all(list.map(r => ASSIST.whereFor(r, r.h * 60 + r.m, prefsFromProfile()))).then(ws => {
    if (token !== recoToken) return;
    ws.forEach((w, i) => { const slot = document.querySelector(`[data-where="${i}"]`); if (slot) slot.innerHTML = ASSIST.whereHTML(w, true); });
  });
}

function renderHome() {
  const active = state.tasks.filter(t => t.status === 'active').sort((a, b) => a.deadline - b.deadline);
  const atRisk = active.reduce((sum, t) => sum + t.penalty, 0);
  const line = $('#greet-date');
  line.textContent = active.length ? `${active.length} running, ${fmtMoney(atRisk)} at stake` : '';
  line.classList.toggle('hidden', !active.length);

  const offers = state.tasks.filter(t => t.status === 'offer').sort((a, b) => a.offerExpiresAt - b.offerExpiresAt);
  $('#offers').innerHTML = offers.map(offerCardHTML).join('');

  const list = $('#tasks-active-list');
  list.innerHTML = active.length
    ? taskCardHTML(active[0], true) + (active.length > 1 ? `<div class="rest">${active.slice(1).map(t => taskCardHTML(t, false)).join('')}</div>` : '')
    : '';
  $$('.task-card', list).forEach((c, i) => c.style.setProperty('--i', i));
  $('#no-tasks').classList.toggle('hidden', active.length > 0 || offers.length > 0);
  const attention = active.length + offers.length;
  $$('[data-badge="active"]').forEach(b => { b.textContent = attention; b.classList.toggle('hidden', !attention); b.classList.toggle('offer', offers.length > 0); });
  renderOfferBanner();
  renderRecommended();
  updateTopbarBalance();
}

/* ---------- history: balance, insights, chart, results, activity ---------- */
const DAY_MS = 86400000;
let historyFilter = 'all', historyLimit = 8;
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const resolvedAt = t => (t.status === 'completed' ? t.completedAt : t.status === 'bailed' ? t.bailedAt : (t.failedAt || t.deadline));
const resolvedTasks = () => state.tasks.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'bailed').sort((a, b) => resolvedAt(b) - resolvedAt(a));

function dayLabel(ts) {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function historyStats() {
  const list = resolvedTasks();
  const done = list.filter(t => t.status === 'completed');
  const counted = list.filter(t => t.status !== 'bailed');                    // a bailed task is neither a win nor a miss
  let streak = 0;
  for (const t of counted) { if (t.status !== 'completed') break; streak++; } // newest first, stop at the first miss
  return {
    list, done: done.length, missed: counted.length - done.length, streak,
    rate: counted.length ? Math.round((done.length / counted.length) * 100) : null,
    kept: done.reduce((sum, t) => sum + t.penalty, 0)
  };
}

// Two-tone bars for the last 14 days: completed on the bottom, missed stacked above.
function chartData(list) {
  const today = startOfDay(Date.now());
  const days = Array.from({ length: 14 }, (_, i) => ({ ts: today - (13 - i) * DAY_MS, done: 0, missed: 0 }));
  list.filter(t => t.status !== 'bailed').forEach(t => {
    const d = days.find(x => x.ts === startOfDay(resolvedAt(t)));
    if (d) t.status === 'completed' ? d.done++ : d.missed++;
  });
  return days;
}
function chartHTML(days) {
  const max = Math.max(1, ...days.map(d => d.done + d.missed));
  return days.map((d, i) => {
    const label = new Date(d.ts).toLocaleDateString([], { weekday: 'narrow' });
    const tip = `${new Date(d.ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${d.done} completed, ${d.missed} missed`;
    return `<div class="bar${i === 13 ? ' today' : ''}" title="${esc(tip)}">
      <div class="bar-col"><i class="b-miss" style="height:${(d.missed / max) * 100}%"></i><i class="b-done" style="height:${(d.done / max) * 100}%"></i></div>
      <span>${label}</span></div>`;
  }).join('');
}

function historyItemHTML(t) {
  if (t.status === 'bailed') {
    return `<div class="history-item">
      <span class="h-dot" aria-hidden="true"></span>
      <div class="h-main"><p>${esc(t.name)}</p><small>Bailed out · ticket used</small></div>
      <span class="h-amt bail">🎫 ${fmtMoney(t.penalty)} kept</span>
    </div>`;
  }
  const done = t.status === 'completed';
  const when = resolvedAt(t);
  const charity = state.charities.find(c => c.id === t.charityId);
  const meta = done ? (t.wonBack ? 'Won back' : fmtClock(when)) : `${t.retryMissed ? 'Missed twice, ' : ''}to ${charity ? charity.name : 'charity'}`;
  const amount = done
    ? `<span class="h-amt keep">+${fmtMoney(t.penalty)}</span>`
    : `<span class="h-amt lost">-${fmtMoney(t.charged || 0)}</span>`;
  return `<div class="history-item ${done ? '' : 'failed'}">
    <span class="h-dot" aria-hidden="true"></span>
    <div class="h-main"><p>${esc(t.name)}</p><small>${esc(meta)}</small></div>
    ${amount}
    ${done && t.proof ? `<button class="thumb" data-report="${t.id}" aria-label="View proof photo"><img src="${t.proof.image}" alt="Proof photo"/></button>` : ''}
  </div>`;
}

function renderRecord() {
  const st = historyStats();
  $('#hero-balance').textContent = fmtMoney(state.balance);
  $('#stat-completed').textContent = st.done;
  $('#stat-missed').textContent = st.missed;
  $('#stat-sent').textContent = fmtMoney(state.totalSent);

  const days = chartData(st.list);
  const dd = days.reduce((n, d) => n + d.done, 0), dm = days.reduce((n, d) => n + d.missed, 0);
  $('#chart').innerHTML = chartHTML(days);
  $('#chart').setAttribute('aria-label', `In the last 14 days you completed ${dd} and missed ${dm} tasks.`);

  // results, filtered and grouped by day
  const shown = st.list.filter(t => historyFilter === 'all' || t.status === historyFilter);
  const page = shown.slice(0, historyLimit);
  let html = '', lastDay = null;
  page.forEach(t => {
    const label = dayLabel(resolvedAt(t));
    if (label !== lastDay) { html += `<h3 class="day-head">${esc(label)}</h3>`; lastDay = label; }
    html += historyItemHTML(t);
  });
  $('#tasks-history-list').innerHTML = html || `<p class="plain-empty">${st.list.length ? 'No matches.' : 'Nothing yet.'}</p>`;
  $('#btn-history-more').classList.toggle('hidden', shown.length <= historyLimit);
  $('#btn-history-more').textContent = 'Show more';
  $$('#history-filter .seg-btn').forEach(b => { const on = b.dataset.hf === historyFilter; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
}

function updateTopbarBalance() {
  $('#topbar-balance').textContent = fmtMoney(state.balance);
  $('#topbar-retries').textContent = `↩️ ${retriesLeft()}`;
  $('#topbar-retries').setAttribute('aria-label', `${retriesLeft()} ${retriesLeft() === 1 ? 'retry' : 'retries'} left. Open shop`);
  $('#topbar-tickets').textContent = `🎫 ${state.tickets}`;
  $('#topbar-tickets').setAttribute('aria-label', `${state.tickets} bail-out ticket${state.tickets === 1 ? '' : 's'}. Open shop`);
  $$('[data-badge="tickets"]').forEach(b => { b.textContent = state.tickets; b.classList.toggle('hidden', !state.tickets); });
}

/* ---------- activity & money flow ---------- */
function pushActivity(icon, text, type) {
  state.activity.unshift({ icon, text, at: Date.now(), type });
  if (state.activity.length > 30) state.activity.length = 30;
}

/* ---------- one more try ----------
   The first miss does not send the stake. It is held while an offer is open, for 10 minutes counted from the deadline:
   accept and finish the retry in time to keep it, or decline (or let the offer lapse) and it goes to charity.
   A missed retry is final. If the deadline passed while the app was closed, only what is left of the 10 minutes is offered. */
const OFFER_MS = 10 * 60000;
const fmtLen = ms => {
  const m = Math.round(ms / 60000);
  if (m >= 2880 && m % 1440 === 0) return `${m / 1440}d`;
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};
const defaultRetryMs = t => Math.min(7 * 86400000, Math.max(15 * 60000, t.durationMs));         // same length as the original
// "Same length", plus 1h, 4h and 24h, without duplicates, shortest first.
const retryChoices = t => [...new Set([defaultRetryMs(t), 3600000, 4 * 3600000, 24 * 3600000])].sort((a, b) => a - b);

// Four free retries a month, then bought ones. The free count starts over each calendar month.
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function freeRetriesLeft() {
  if (!HTTP && state.retries.month !== monthKey()) state.retries = { month: monthKey(), used: 0 };   // with the backend, its count (in the account's timezone) is the one that applies
  return Math.max(0, RETRIES_PER_MONTH - state.retries.used);
}
const retriesLeft = () => freeRetriesLeft() + state.extraRetries;
function useRetry() {                                                // free ones go first, so bought ones last
  if (freeRetriesLeft() > 0) state.retries.used += 1;
  else state.extraRetries -= 1;
}

// Stakes held for an open offer can't be spent on tickets or new tasks until the offer ends.
const heldStake = () => state.tasks.filter(t => t.status === 'offer').reduce((sum, t) => sum + t.penalty, 0);
const spendable = () => (HTTP ? state.spendable : Math.max(0, state.balance - heldStake()));   // the server reserves stakes when a task starts

function failTask(t) {
  if ((t.attempt || 1) < 2) {
    const expires = t.deadline + OFFER_MS;                           // the window starts at the deadline, not when the miss is noticed
    if (Date.now() >= expires) { chargeMiss(t, false); return; }     // it ended while the app was closed
    t.status = 'offer';
    t.missedAt = t.deadline;
    t.offerExpiresAt = expires;
    t.offerChoiceMs = defaultRetryMs(t);
    pushActivity('⏳', `Missed "${t.name}": one more try offered`, 'offer');
    saveState();
    flash('try');
    toast('Missed. One more try?', 'try');
    return;
  }
  chargeMiss(t, true);
}

// The stake goes to the chosen charity. `retried` marks a miss that happened on the second attempt.
function chargeMiss(t, retried) {
  const c = selectedCharity();
  const charged = Math.min(t.penalty, Math.max(0, state.balance));
  state.balance -= charged;
  state.totalSent += charged;
  if (charged > 0) c.raised += charged;
  t.status = 'failed';
  t.failedAt = Date.now();
  t.charged = charged;
  t.charityId = c.id;
  t.retryMissed = !!retried;
  delete t.offerExpiresAt; delete t.offerChoiceMs;
  pushActivity('💸', `Missed "${t.name}" — ${fmtMoney(charged)} sent to ${c.name}`, 'penalty');
  saveState();
  if (retried) flash();
  toast(retried ? `Missed again. ${fmtMoney(charged)} to ${c.name}` : `Missed "${t.name}". ${fmtMoney(charged)} to ${c.name}`, 'warn');
  if (state.balance <= 0) setTimeout(() => toast('Balance is empty', 'error'), 400);
}

// Clears a task the person is truly blocked on: one ticket is spent, the stake is never charged.
async function bailOut(id) {
  const t = taskById(id);
  if (!t || t.status !== 'active' || (t.attempt || 1) === 2) return;   // no bailing out of a retry
  if (state.tickets < 1) {
    toast('No tickets left. Buy one in the Shop', 'error');     // stay on this screen
    return;
  }
  if (HTTP) {
    const card = document.querySelector(`.task-card[data-task-id="${id}"]`);
    $('#tasks-active-list').classList.add('still');
    if (card && !reduceMotion()) { card.classList.add('leaving'); await sleep(200); }
    const r = await act(() => API.bail(id));
    if (!r) { if (card) card.classList.remove('leaving'); return; }
    toast(`Cleared "${t.name}". ${state.tickets} ticket${state.tickets === 1 ? '' : 's'} left`, 'success');
    return;
  }
  state.tickets -= 1;
  t.status = 'bailed';
  t.bailedAt = Date.now();
  pushActivity('🎫', `Bailed out of "${t.name}" · ${fmtMoney(t.penalty)} stake kept`, 'bail');
  saveState();
  // the cleared card folds away and the others stay put: no entry animations replay, no jump to the top
  const card = document.querySelector(`.task-card[data-task-id="${id}"]`);
  $('#tasks-active-list').classList.add('still');
  if (card && !reduceMotion()) { card.classList.add('leaving'); await sleep(200); }
  renderAll();
  toast(`Cleared "${t.name}". ${state.tickets} ticket${state.tickets === 1 ? '' : 's'} left`, 'success');
}

/* ---------- shop: two kinds of ticket ---------- */
// Both are bought the same way and described the same way; only what they do differs.
const SHOP_ITEMS = [
  {
    id: 'bail', icon: '🎫', name: 'Bail-out ticket', unit: ['ticket', 'tickets'], price: () => TICKET_PRICE, packs: TICKET_PACKS, buyAttr: 'data-buy',
    when: 'Truly blocked from finishing a task',
    owned: () => state.tickets,
    sub: () => 'Never expire',
    how: ['Clears the task: you keep your stake', 'Nothing goes to charity', "The task doesn't count as missed", 'A used ticket is gone']
  },
  {
    id: 'retry', icon: '↩️', name: 'One more try', unit: ['retry', 'retries'], price: () => RETRY_PRICE, packs: RETRY_PACKS, buyAttr: 'data-buy-retry',
    when: 'After a miss, to have another go',
    owned: () => retriesLeft(),
    sub: () => `${freeRetriesLeft()} of ${RETRIES_PER_MONTH} free this month${state.extraRetries ? `, ${state.extraRetries} bought` : ''}`,
    how: [`${RETRIES_PER_MONTH} free every month, used first`, 'Bought retries never expire', 'Pick a new deadline for the same task']
  }
];

const plural = (n, [one, many]) => (n === 1 ? one : many);

function shopItemHTML(it) {
  const price = it.price();
  const packs = it.packs.map(n => {
    const cost = packCost(n, it.id);
    return `<div class="shop-pack">
      <div><b>${n} ${plural(n, it.unit)}</b><small>${fmtMoney(cost)}${n > 1 ? ` · save ${fmtMoney(n * price - cost)}` : ''}</small></div>
      <button class="btn ghost sm" ${it.buyAttr}="${n}" ${cost > spendable() ? 'disabled' : ''}>Buy</button>
    </div>`;
  }).join('');
  return `<section class="card shop-item" aria-labelledby="shop-${it.id}-title">
    <header class="shop-item-head">
      <span class="shop-item-ico" aria-hidden="true">${it.icon}</span>
      <div><h3 id="shop-${it.id}-title">${it.name}</h3><p class="sub">${it.when}</p></div>
      <div class="shop-item-own"><b class="num">${it.owned()}</b><small>${plural(it.owned(), it.unit)}</small></div>
    </header>
    <p class="shop-status">${it.sub()}</p>
    <ul class="shop-how">${it.how.map(h => `<li>${h}</li>`).join('')}</ul>
    <p class="shop-price-line">${fmtMoney(price)} each, less in bigger packs</p>
    <div class="shop-packs">${packs}</div>
  </section>`;
}

// The deck swipes sideways; the card nearest the middle is the one in front.
function shopCardIndex() {
  const deck = $('#shop-items');
  const mid = deck.scrollLeft + deck.clientWidth / 2;
  const cards = [...deck.children];
  let best = 0;
  cards.forEach((c, i) => { if (Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid) < Math.abs(cards[best].offsetLeft + cards[best].offsetWidth / 2 - mid)) best = i; });
  return best;
}
function markShopCard() {
  const at = shopCardIndex();
  [...$('#shop-items').children].forEach((c, i) => c.classList.toggle('front', i === at));
  $$('.shop-dot, .shop-inv').forEach(b => { const on = +b.dataset.shopCard === at; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'true' : 'false'); });
}
function showShopCard(i) {
  const c = $('#shop-items').children[i];
  if (c) $('#shop-items').scrollTo({ left: c.offsetLeft - ($('#shop-items').clientWidth - c.offsetWidth) / 2, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function renderShop() {
  $('#shop-wallet').innerHTML = `
    <div class="shop-wallet-main"><p class="sub">Balance</p><p class="ledger-balance">${fmtMoney(state.balance)}</p></div>
    <div class="shop-inventory" role="list" aria-label="What you own">
      ${SHOP_ITEMS.map((it, i) => `<button type="button" class="shop-inv" role="listitem" data-shop-card="${i}" aria-label="Show ${it.name}"><span aria-hidden="true">${it.icon}</span><b class="num">${it.owned()}</b><small>${plural(it.owned(), it.unit)}</small></button>`).join('')}
    </div>`;
  const deck = $('#shop-items');
  const keep = deck.scrollLeft;                                    // a re-render after a purchase must not jump back to the first card
  deck.innerHTML = SHOP_ITEMS.map(shopItemHTML).join('');
  $('#shop-dots').innerHTML = SHOP_ITEMS.map((it, i) => `<button type="button" class="shop-dot" data-shop-card="${i}" aria-label="${it.name}"></button>`).join('');
  deck.scrollLeft = keep;
  markShopCard();
  $('#shop-note').textContent = spendable() < Math.min(...SHOP_ITEMS.map(it => it.price())) ? 'Add funds in Settings to buy tickets.' : '';
}

function buyRetries(n) {
  const cost = packCost(n, 'retry');
  if (!RETRY_PACKS.includes(n)) return;
  if (cost > spendable()) { toast(`Not enough balance (${fmtMoney(spendable())})`, 'error'); return; }
  if (HTTP) { act(() => API.buy('retry', n, uid())).then(r => r && toast(`${n} ${n > 1 ? 'retries' : 'retry'} added`, 'success')); return; }
  state.balance -= cost;
  state.extraRetries += n;
  pushActivity('↩️', `Bought ${n} ${n > 1 ? 'retries' : 'retry'} for ${fmtMoney(cost)}`, 'ticket');
  saveState();
  renderAll();
  toast(`${n} ${n > 1 ? 'retries' : 'retry'} added`, 'success');
}

function buyTickets(n) {
  const cost = packCost(n, 'bail');
  if (!TICKET_PACKS.includes(n)) return;
  if (cost > spendable()) { toast(`Not enough balance (${fmtMoney(spendable())})`, 'error'); return; }
  if (HTTP) { act(() => API.buy('bail', n, uid())).then(r => r && toast(`${n} ticket${n > 1 ? 's' : ''} added`, 'success')); return; }
  state.balance -= cost;
  state.tickets += n;
  pushActivity('🎫', `Bought ${n} bail-out ticket${n > 1 ? 's' : ''} for ${fmtMoney(cost)}`, 'ticket');
  saveState();
  renderAll();
  toast(`${n} ticket${n > 1 ? 's' : ''} added`, 'success');
}

function acceptOffer(id) {
  const t = taskById(id);
  if (!t || t.status !== 'offer') return;
  if (Date.now() >= t.offerExpiresAt) { if (HTTP) syncSoon(0); else { chargeMiss(t, false); renderAll(); } return; }   // it lapsed between ticks
  if (retriesLeft() < 1) { toast('No retries left. Get more in the Shop', 'error'); showView('shop'); return; }
  if (HTTP) {
    act(() => API.retry(id, t.offerChoiceMs || defaultRetryMs(t))).then(r => { const u = r && taskById(id); if (u) toast(`One more try. Finish by ${fmtDeadline(u.deadline)}`, 'success'); });
    return;
  }
  useRetry();
  const ms = t.offerChoiceMs || defaultRetryMs(t), now = Date.now();
  t.status = 'active';
  t.attempt = 2;
  t.createdAt = now;
  t.durationMs = ms;
  t.deadline = now + ms;
  t.byDate = false;
  delete t.offerExpiresAt; delete t.offerChoiceMs;
  pushActivity('↩️', `One more try on "${t.name}"`, 'offer');
  saveState();
  renderAll();
  toast(`One more try. Finish by ${fmtDeadline(t.deadline)}`, 'success');
}

function declineOffer(id) {
  const t = taskById(id);
  if (!t || t.status !== 'offer') return;
  if (HTTP) {
    act(() => API.decline(id)).then(r => { const u = r && taskById(id); if (u) toast(`Missed "${u.name}". ${fmtMoney(u.charged || 0)} to ${(state.charities.find(c => c.id === u.charityId) || {}).name || 'charity'}`, 'warn'); });
    return;
  }
  chargeMiss(t, false);
  renderAll();
}

// While an offer is open, every screen but Today shows a banner with its countdown. Tapping it goes to the offer.
function renderOfferBanner() {
  const banner = $('#offer-banner');
  if (!banner) return;
  const offers = state.tasks.filter(t => t.status === 'offer').sort((a, b) => a.offerExpiresAt - b.offerExpiresAt);
  document.title = offers.length ? 'One more try? Commit' : 'Commit — Stay Accountable';       // visible on the browser tab too
  const show = offers.length > 0 && document.body.dataset.view !== 'home';
  banner.classList.toggle('hidden', !show);
  if (!offers.length) return;
  const t = offers[0];
  $('#ob-name').textContent = offers.length > 1 ? `${offers.length} tasks` : t.name;
  const timer = $('#ob-timer');
  timer.dataset.offerTimer = t.id;
  timer.textContent = fmtCountdown(Math.max(0, t.offerExpiresAt - Date.now()));
}

function offerCardHTML(t) {
  const remaining = Math.max(0, t.offerExpiresAt - Date.now());
  const chips = retryChoices(t).map(ms => `<button type="button" class="chip${ms === t.offerChoiceMs ? ' active' : ''}" role="radio" aria-checked="${ms === t.offerChoiceMs}" data-offer-pick="${t.id}" data-ms="${ms}">${fmtLen(ms)}</button>`).join('');
  return `<article class="offer-card" data-offer-id="${t.id}">
    <div class="offer-head">
      <div><h3><svg class="ico" aria-hidden="true"><use href="#i-retry"/></svg>One more try?</h3><p class="sub">${esc(t.name)}, ${fmtMoney(t.penalty)}</p></div>
      <span class="offer-timer num" data-offer-timer="${t.id}" aria-label="Offer ends in">${fmtCountdown(remaining)}</span>
    </div>
    <p class="offer-line">Finish it in time to keep your ${fmtMoney(t.penalty)}. Miss again and it goes to charity.</p>
    <p class="offer-left">${retriesLeft() ? `${retriesLeft()} ${retriesLeft() === 1 ? 'retry' : 'retries'} left` : 'No retries left'}</p>
    <div class="chip-row" role="radiogroup" aria-label="Time to finish">${chips}</div>
    <div class="offer-actions">${retriesLeft() ? `<button class="btn primary" data-offer-accept="${t.id}">Accept</button>` : `<button class="btn primary" data-offer-shop>Get retries</button>`}<button class="btn ghost" data-offer-decline="${t.id}">Let it go</button></div>
  </article>`;
}

function completeTask(t, proof) {
  if (HTTP) { celebrate(t, proof); return; }                      // the server completed it, and renderAll already ran
  t.status = 'completed';
  t.completedAt = Date.now();
  if ((t.attempt || 1) === 2) t.wonBack = true;                   // the retry succeeded, so the held stake comes back
  if (proof) t.proof = proof;
  pushActivity('✅', `Completed "${t.name}"${proof ? ` · verified ${proof.ai.confidence}% confidence` : ''}`, 'completed');
  saveState();
  renderAll();
  celebrate(t, proof);
}

/* ---------- completion celebration ---------- */
function celebrate(t, proof) {
  const stake = fmtMoney(t.penalty);
  $('#done-title').textContent = t.wonBack ? 'Won back' : 'Done';
  $('#done-stake').textContent = `${stake} kept`;
  $('#overlay-done').classList.remove('hidden');
  document.body.classList.add('no-scroll');
  if (navigator.vibrate) navigator.vibrate([30, 50, 70]);
  setTimeout(() => $('#btn-done-close').focus(), 800);
}

function closeCelebration() {
  $('#overlay-done').classList.add('hidden');
  document.body.classList.remove('no-scroll');
  showView('home');
}

/* ---------- live timers ---------- */
let tickTimer = null;
function startTick() { if (tickTimer) clearInterval(tickTimer); tickTimer = setInterval(tick, 1000); }

function tick() {
  if (!currentUser) return;   // timers only run (and expire) for a signed-in user
  let expired = false;
  if (HTTP) {                                                   // the server settles missed deadlines; ask it when one is due
    if (state.tasks.some(t => (t.status === 'active' && Date.now() >= t.deadline) || (t.status === 'offer' && Date.now() >= t.offerExpiresAt))) syncSoon();
  } else state.tasks.forEach(t => {
    if (t.status === 'active' && Date.now() >= t.deadline) { failTask(t); expired = true; }
    else if (t.status === 'offer' && Date.now() >= t.offerExpiresAt) { chargeMiss(t, false); expired = true; }   // the offer lapsed
  });
  $$('[data-offer-timer]').forEach(el => { const t = taskById(el.dataset.offerTimer); if (t && t.status === 'offer') el.textContent = fmtCountdown(Math.max(0, t.offerExpiresAt - Date.now())); });

  $$('.task-card[data-task-id]').forEach(card => {
    const t = taskById(card.dataset.taskId);
    if (!t || t.status !== 'active') return;
    const remaining = Math.max(0, t.deadline - Date.now());
    const pct = Math.max(0, (remaining / t.durationMs) * 100);
    const cd = $(`[data-countdown="${t.id}"]`, card);
    if (cd) { setCountdown(cd, fmtCountdown(remaining)); cd.setAttribute('aria-label', `${fmtCountdown(remaining)} remaining`); }
    const pf = $(`[data-progress="${t.id}"]`, card);
    if (pf) pf.style.width = pct + '%';
    const ring = $(`[data-ring="${t.id}"]`, card);
    if (ring) ring.style.strokeDashoffset = (100 - pct).toFixed(2);
    card.classList.toggle('long', fmtCountdown(remaining).length > RING_LONG);
    const urgentMs = Math.min(t.durationMs * 0.25, 6 * 3600000), criticalMs = Math.min(t.durationMs * 0.10, 3600000);
    card.classList.toggle('urgent', remaining <= urgentMs && remaining > criticalMs);
    card.classList.toggle('critical', remaining <= criticalMs);
  });

  $$('[data-timeago]').forEach(el => { el.textContent = timeAgo(+el.dataset.timeago); });

  if (expired) renderAll();
}

/* ---------- task help (nearby places, prices, plans) ---------- */
function anyOtherOverlayOpen() {
  return !!document.querySelector('.overlay:not(.hidden):not(#overlay-help), .guide-overlay:not(.hidden), .onb-overlay:not(.hidden), .proof-overlay:not(.hidden), .done-overlay:not(.hidden)');
}

async function openHelp(task, mins, prefs) {
  const help = await ASSIST.load(task, mins, prefs || prefsFromProfile());
  $('#help-body').innerHTML = ASSIST.fullHTML(help);
  $('#overlay-help').classList.remove('hidden');
  document.body.classList.add('no-scroll');
}

function closeHelp() {
  $('#overlay-help').classList.add('hidden');
  if (!anyOtherOverlayOpen()) document.body.classList.remove('no-scroll');
}

/* ---------- add task ---------- */
// The mock AI recognises a task by its icon, so pick one from the name instead of asking the person to.
let selectedIcon = null;                 // set when a suggestion brings its own icon
function iconFor(name) {
  const E = MOCK.EMOJIS, kind = ASSIST.kindOf({ name });
  const byKind = { gym: E[0], run: E[5], study: E[4], cook: E[1], yoga: E[6], work: E[2], art: E[8] };
  if (byKind[kind]) return byKind[kind];
  if (/tidy|clean|laundry|declutter|organi[sz]e/i.test(name)) return E[3];
  if (/vitamin|pill|medic/i.test(name)) return E[7];
  if (/plant|water/i.test(name)) return E[9];
  return '📌';
}

// Time limit ("in 2 hours") or due date ("Friday 6 PM"). Both end up as one deadline timestamp.
let addMode = 'duration';
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MIN_LEAD_MS = 5 * 60000, MAX_LEAD_MS = 365 * 86400000;

function computeDeadline() {
  const now = Date.now();
  if (addMode === 'duration') {
    const h = Math.min(72, Math.max(0, +$('#at-hours').value || 0));
    const m = Math.min(59, Math.max(0, +$('#at-minutes').value || 0));
    const ms = (h * 60 + m) * 60000;
    return ms > 0 ? { ok: true, deadline: now + ms, durationMs: ms } : { ok: false, error: 'Set a time limit' };
  }
  const date = $('#at-date').value, time = $('#at-time').value;
  if (!date) return { ok: false, error: 'Pick a due date' };
  if (!time) return { ok: false, error: 'Pick a due time' };
  const [y, mo, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const ts = new Date(y, mo - 1, d, hh, mm).getTime();
  if (Number.isNaN(ts)) return { ok: false, error: 'Invalid date' };
  if (ts - now < MIN_LEAD_MS) return { ok: false, error: 'Pick a time 5 or more minutes ahead' };
  if (ts - now > MAX_LEAD_MS) return { ok: false, error: 'Up to a year ahead' };
  return { ok: true, deadline: ts, durationMs: ts - now };
}

function updateDuePreview() {
  const r = computeDeadline();
  const box = $('#at-due-preview');
  box.classList.toggle('bad', !r.ok && addMode === 'date' && !!$('#at-date').value);
  if (r.ok) box.textContent = addMode === 'date'
    ? `Due ${fmtDeadline(r.deadline)}`
    : `Ends ${fmtDeadline(r.deadline)}`;
  else box.textContent = addMode === 'date' && $('#at-date').value ? r.error : '';
}

function setAddMode(mode) {
  addMode = mode;
  $$('.seg-btn').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  $('#at-mode-duration').classList.toggle('hidden', mode !== 'duration');
  $('#at-mode-date').classList.toggle('hidden', mode !== 'date');
  updateDuePreview();
  updateAddAssist();
}

// Named shortcuts resolve to a date and a time ("Friday" means Friday 6 PM). Returns null when it is too late for today's.
function dateShortcut(key, now = new Date()) {
  const at = (d, h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const soon = t => t.getTime() - now.getTime() < MIN_LEAD_MS;
  if (key === 'tonight') {
    let t = at(now, 21);
    if (soon(t)) t = at(now, 23);
    return soon(t) ? null : t;
  }
  if (key === 'friday') {
    const add = (5 - now.getDay() + 7) % 7;
    let t = at(addDays(now, add), 18);
    if (soon(t)) t = addDays(t, 7);
    return t;
  }
  if (key === 'weekend') {                       // the end of the weekend: Sunday 6 PM
    const add = (7 - now.getDay()) % 7;
    let t = at(addDays(now, add), 18);
    if (soon(t)) t = addDays(t, 7);
    return t;
  }
  if (key === 'monthend') {
    let t = at(new Date(now.getFullYear(), now.getMonth() + 1, 0), 18);
    if (soon(t)) t = at(new Date(now.getFullYear(), now.getMonth() + 2, 0), 18);
    return t;
  }
  return null;
}

function setDateShortcut(key) {
  const t = dateShortcut(key);
  if (!t) return;
  $('#at-date').value = localDate(t);
  $('#at-time').value = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  $$('#date-presets .chip').forEach(c => c.classList.toggle('active', c.dataset.when === key));
  updateDuePreview();
  updateAddAssist();
}

// a shortcut that has no valid time left today (like "Tonight" at midnight) is greyed out
const refreshShortcuts = () => $$('#date-presets [data-when]').forEach(c => { c.disabled = !dateShortcut(c.dataset.when); });

function setDatePreset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  $('#at-date').value = localDate(d);
  if (!$('#at-time').value) $('#at-time').value = '18:00';       // a preset should never leave the time blank
  $$('#date-presets .chip').forEach(c => c.classList.toggle('active', +c.dataset.days === days));
  // a due time that has already passed today would be refused, so move it to the next full hour
  if (days === 0) {
    const [hh, mm] = ($('#at-time').value || '18:00').split(':').map(Number);
    if (new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime() - Date.now() < MIN_LEAD_MS) {
      const next = new Date(Date.now() + 3600000);
      $('#at-time').value = `${pad(next.getHours())}:00`;
    }
  }
  updateDuePreview();
  updateAddAssist();
}

function showCustomDuration(on) {
  $('#at-custom').classList.toggle('hidden', !on);
  const custom = $('#duration-presets [data-custom]');
  custom.classList.toggle('active', on);
  if (on) $$('#duration-presets [data-h]').forEach(c => c.classList.remove('active'));
}

// Under the task name: where the task could be done, when we recognise it (gym, run, study, cook, yoga, focus work, art, chores).
let assistToken = 0;
async function updateAddAssist() {
  const box = $('#at-assist');
  const token = ++assistToken;
  const task = { name: $('#at-name').value.trim() };
  const r = computeDeadline();
  const mins = addMode === 'duration' && r.ok ? Math.round(r.durationMs / 60000) : undefined;   // a due date has no fixed session length
  const [where, help] = await Promise.all([ASSIST.whereFor(task, mins, prefsFromProfile()), ASSIST.load(task, mins, prefsFromProfile())]);
  if (token !== assistToken) return;            // a newer edit already replaced this answer
  box.classList.toggle('hidden', !where);
  box.innerHTML = where ? `${ASSIST.whereHTML(where, true, true)}${help ? '<button type="button" class="link-btn" id="at-assist-more">See details</button>' : ''}` : '';
}

// Set the time limit from a number of minutes: a matching preset lights up, anything else opens the custom fields.
function setDuration(h, m) {
  $('#at-hours').value = h;
  $('#at-minutes').value = m;
  const match = $$('#duration-presets [data-h]').find(c => +c.dataset.h === h && +c.dataset.m === m);
  $$('#duration-presets .chip').forEach(c => c.classList.toggle('active', c === match));
  showCustomDuration(!match);
}

// Questions that belong to this particular task. Answers fill in the name and the time limit.
let refine = { base: '', picks: {} };
function renderRefine() {
  const box = $('#at-refine');
  const qs = ASSIST.questionsFor({ name: refine.base });
  box.classList.toggle('hidden', !qs.length);
  box.innerHTML = qs.map(q => `<div class="refine-q" role="group" aria-label="${esc(q.q)}"><span>${esc(q.q)}</span>
    <div class="chip-row">${q.options.map((o, i) => `<button type="button" class="chip${refine.picks[q.id] === i ? ' active' : ''}" data-rq="${q.id}" data-ri="${i}">${esc(o.label)}</button>`).join('')}</div></div>`).join('');
}
function applyRefine(qid, i) {
  const q = ASSIST.questionsFor({ name: refine.base }).find(x => x.id === qid);
  if (!q || !q.options[i]) return;
  refine.picks[qid] = refine.picks[qid] === i ? undefined : i;           // tap again to undo
  const o = q.options[i];
  if (o.mins && refine.picks[qid] === i) setDuration(Math.floor(o.mins / 60), o.mins % 60);
  const extra = ASSIST.questionsFor({ name: refine.base })
    .map(x => x.options[refine.picks[x.id]]).filter(x => x && x.add).map(x => x.add).join(', ');
  $('#at-name').value = (extra ? `${refine.base} · ${extra}` : refine.base).slice(0, 40);
  renderRefine(); updateDuePreview(); updateAddAssist();
}

function openAddTask(preset) {
  const p = preset && preset.name ? preset : null;   // click handlers pass an Event; only plain presets count
  const h = p ? p.h : 1, m = p ? p.m : 0;
  $('#at-name').value = p ? p.name : '';
  refine = { base: p ? p.name : '', picks: {} };
  renderRefine();
  $('#at-hours').value = h;
  $('#at-minutes').value = m;
  $('#at-penalty').value = Math.max(MIN_STAKE, p ? p.stake : (state.defaultPenalty || MIN_STAKE));
  selectedIcon = p && p.icon ? p.icon : null;
  const match = $$('#duration-presets [data-h]').find(c => +c.dataset.h === h && +c.dataset.m === m);
  $$('#duration-presets .chip').forEach(c => c.classList.toggle('active', c === match));
  showCustomDuration(!match);                       // a length that is not a preset opens the custom fields
  $('#at-time').value = '18:00';
  $('#at-date').min = localDate(new Date());
  setDatePreset(1);                                  // the date picker starts on tomorrow
  refreshShortcuts();
  setAddMode('duration');
  $('#overlay-add').classList.remove('hidden');
  document.body.classList.add('no-scroll');
  setTimeout(() => $('#at-name').focus(), 60);
}

function closeAddTask() {
  $('#overlay-add').classList.add('hidden');
  document.body.classList.remove('no-scroll');
}

function submitAddTask(e) {
  e.preventDefault();
  const name = $('#at-name').value.trim();
  const penalty = Math.round(+$('#at-penalty').value) || state.defaultPenalty;
  if (!name) { toast('Name your task', 'error'); return; }
  if (penalty < MIN_STAKE) { toast(`Minimum stake is ${fmtMoney(MIN_STAKE)}`, 'error'); return; }
  const when = computeDeadline();
  if (!when.ok) { toast(when.error, 'error'); return; }
  if (penalty > spendable()) { toast(`Stake is above your balance (${fmtMoney(spendable())})`, 'error'); return; }

  if (HTTP) {
    const task = { name, icon: selectedIcon || iconFor(name), byDate: addMode === 'date', deadline: when.deadline, penalty };
    act(() => API.createTask(task, uid())).then(r => { if (r) { closeAddTask(); toast(`Started. Due ${fmtDeadline(when.deadline)}`, 'success'); } });
    return;
  }
  state.tasks.unshift({
    id: uid(), name, icon: selectedIcon || iconFor(name), status: 'active', byDate: addMode === 'date',
    createdAt: Date.now(), deadline: when.deadline, durationMs: when.durationMs, penalty
  });
  saveState();
  closeAddTask();
  renderHome();
  toast(`Started. Due ${fmtDeadline(when.deadline)}`, 'success');
}

/* ---------- charities ---------- */
const yoursFor = id => state.tasks
  .filter(t => t.status === 'failed' && (t.charityId || state.selectedCharityId) === id)
  .reduce((sum, t) => sum + (t.charged || 0), 0);
const goalPct = c => Math.min(100, Math.round((c.raised / c.goal) * 100));

function goalHTML(c) {
  return `<div class="goal"><div class="goal-bar" role="img" aria-label="${goalPct(c)}% of the goal raised"><i style="width:${goalPct(c)}%"></i></div>
    <p><b>${fmtMoney(c.raised)}</b> of ${fmtMoney(c.goal)}</p></div>`;
}

function featureHTML(c) {
  const yours = yoursFor(c.id);
  return `<section class="ch-feature" data-cat="${esc(c.category)}">
    <div class="ch-feature-main">
      <span class="cat">${esc(c.category)}</span>
      <h2>${esc(c.name)}</h2>
      <p class="sub">${esc(c.desc)}</p>
      ${goalHTML(c)}
    </div>
    <dl class="ch-stats">
      <div><dt>You gave</dt><dd>${fmtMoney(yours)}</dd></div>
    </dl>
  </section>`;
}

function charityCardHTML(c, i) {
  return `<article class="charity-card" data-cat="${esc(c.category)}" style="--i:${i + 1}">
    <div class="ch-top"><span class="cat">${esc(c.category)}</span></div>
    <h3>${esc(c.name)}</h3>
    <p class="sub">${esc(c.desc)}</p>
    ${goalHTML(c)}
    <div class="charity-foot"><button class="btn ghost sm" data-select="${c.id}">Choose</button></div>
  </article>`;
}

function renderCharities() {
  $('#charity-feature').innerHTML = featureHTML(selectedCharity());
  $('#charities-list').innerHTML = state.charities.filter(c => c.id !== state.selectedCharityId).map(charityCardHTML).join('');
}

function selectCharity(id) {
  const c = state.charities.find(x => x.id === id);
  if (!c || c.id === state.selectedCharityId) return;
  if (HTTP) {
    act(() => API.setCharity(id)).then(r => { if (r) { window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); toast(`Charity: ${c.name}`, 'success'); } });
    return;
  }
  state.selectedCharityId = id;
  saveState();
  renderCharities();
  renderHome();                                    // the lead task card names the charity
  window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
  toast(`Charity: ${c.name}`, 'success');
}

/* ---------- settings ---------- */
function renderSettings() {
  $('#settings-username').textContent = currentUser.name;
  $('#set-balance').textContent = fmtMoney(state.balance);
  $('#default-penalty').value = state.defaultPenalty;
}

function addFunds(amount) {
  const a = Math.round(+amount);
  if (!a || a <= 0) { toast('Enter an amount', 'error'); return; }
  if (HTTP) { act(() => API.addFunds(a, uid())).then(r => r && toast(`${fmtMoney(a)} added`, 'success')); return; }
  state.balance += a;
  pushActivity('💰', `Added ${fmtMoney(a)} to account`, 'funds');
  saveState();
  renderAll();
  toast(`${fmtMoney(a)} added`, 'success');
}

function resetDemoData() {
  if (HTTP) { act(() => API.reset()).then(r => { if (r) { showView('home'); toast('Reset', 'info'); } }); return; }
  localStorage.removeItem(keyFor(LS_STATE));
  state = normalizeState(newStateFor(currentUser.username));
  saveState();
  renderAll();
  showView('home');
  toast('Reset', 'info');
}

/* ---------- proof flow: camera capture (mobile) ---------- */
const pf = { taskId: null, stream: null, image: null, result: null };

function openProofFlow(taskId) {
  const t = taskById(taskId);
  if (!t || t.status !== 'active') return;
  pf.taskId = taskId;
  pf.image = null;
  pf.result = null;
  $('#pf-task-name').textContent = t.name;
  showPfStage('camera');
  $('#overlay-proof').classList.remove('hidden');
  document.body.classList.add('no-scroll');
  startCamera();
}

function closeProofFlow() {
  stopCamera();
  $('#overlay-proof').classList.add('hidden');
  document.body.classList.remove('no-scroll');
}

function showPfStage(name) {
  $('#pf-camera').classList.toggle('hidden', name !== 'camera');
  $('#pf-analysis').classList.toggle('hidden', name !== 'analysis');
  if (name === 'analysis') resetAnalysisUI();
}

async function startCamera() {
  if (MOCK_CAMERA) {
    $('#pf-mock-view').src = mockSnapFor(taskById(pf.taskId));
    $('#pf-mock-view').classList.remove('hidden');
    $('#pf-camera-error').classList.add('hidden');
    startMockShake();
    return;
  }
  const video = $('#pf-video');
  const errBox = $('#pf-camera-error');
  try {
    if (!hasCamera()) throw new Error('no camera api');
    pf.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = pf.stream;
    await video.play();
    errBox.classList.add('hidden');
  } catch (e) {
    stopCamera();
    errBox.classList.remove('hidden');
  }
}

function stopCamera() {
  cancelAnimationFrame(mockShakeRaf);
  if (pf.stream) { pf.stream.getTracks().forEach(tr => tr.stop()); pf.stream = null; }
  const v = $('#pf-video');
  if (v) v.srcObject = null;
}

async function captureMock() {
  const view = $('#pf-mock-view');
  const flash = $('#pf-flash');
  flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
  await sleep(180);
  const w = Math.min(900, view.naturalWidth), h = Math.round(view.naturalHeight * w / view.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(view, 0, 0, w, h);
  pf.image = canvas.toDataURL('image/jpeg', 0.85);
  stopCamera();
  runAnalysis();
}

function captureFromVideo() {
  if (MOCK_CAMERA) { captureMock(); return; }
  const video = $('#pf-video');
  if (!video.videoWidth) { toast('Camera not ready yet', 'error'); return; }
  const maxW = 900;
  let w = video.videoWidth, h = video.videoHeight;
  const scale = Math.min(1, maxW / w);
  w = Math.round(w * scale); h = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  pf.image = canvas.toDataURL('image/jpeg', 0.85);
  stopCamera();
  runAnalysis();
}

function downscaleFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxW = 900;
        let w = img.width, h = img.height;
        const scale = Math.min(1, maxW / w);
        w = Math.round(w * scale); h = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------- proof flow: mock AI verification ---------- */
function resetAnalysisUI() {
  $$('#pf-step-list li').forEach(li => li.classList.remove('active', 'done'));
  $('#pf-result').classList.add('hidden');
  $('#btn-pf-done').classList.add('hidden');
  $('#btn-pf-retake').classList.add('hidden');
  $('#pf-conf-fill').style.width = '0%';
}

async function runAnalysis() {
  showPfStage('analysis');
  $('#pf-image').src = pf.image;
  const t = taskById(pf.taskId);

  // With the backend the photo goes to the server, which checks it and completes the task if it passes.
  // Without it the check is pretend. The steps below are for show either way, and run while the answer is on its way.
  let served = null;
  const check = HTTP
    ? API.proof(pf.taskId, pf.image).then(r => { served = r.state; return r.result; })
        .catch(e => ({ error: e }))
    : Promise.resolve(MOCK.verifyProof(t));

  for (const li of $$('#pf-step-list li')) {
    li.classList.add('active');
    await sleep(700 + Math.random() * 500);
    li.classList.remove('active');
    li.classList.add('done');
  }

  const verdict = await check;
  if (verdict.error) {                                              // not a verdict on the photo: the check could not run
    const e = verdict.error;
    if (e.status === 401) return apiFailure(e);
    toast(e.message || 'The photo check failed', 'error');
    if (e.status === 409) { closeProofFlow(); syncSoon(0); }        // the task is no longer running: show where it stands
    else { pf.image = null; showPfStage('camera'); startCamera(); }
    return;
  }
  if (served) { applyServer(served); renderAll(); }
  pf.result = { ...verdict, at: Date.now() };
  renderPfResult();
}

function renderPfResult() {
  const r = pf.result;
  const pass = r.verdict === 'verified';
  const icon = $('#pf-verdict-icon');
  icon.textContent = pass ? '✓' : '✕';
  icon.classList.toggle('fail', !pass);
  $('#pf-verdict-title').textContent = pass ? 'Verified!' : "Couldn't verify";
  $('#pf-verdict-sub').textContent = pass
    ? 'This photo looks like genuine proof of your task.'
    : `${r.note} Try again — the timer keeps running.`;
  $('#pf-conf-text').textContent = r.confidence + '%';
  requestAnimationFrame(() => { $('#pf-conf-fill').style.width = r.confidence + '%'; });
  $('#pf-result').classList.remove('hidden');
  if (pass) $('#btn-pf-done').classList.remove('hidden');
  else $('#btn-pf-retake').classList.remove('hidden');
}

/* ---------- AI report modal ---------- */
function openReport(taskId) {
  const t = taskById(taskId);
  if (!t || !t.proof) return;
  const ai = t.proof.ai;
  $('#report-image').src = t.proof.image;
  $('#report-task-name').textContent = `${t.icon} ${t.name}`;
  $('#report-verdict').textContent = ai.verdict === 'verified' ? 'Verified' : 'Rejected';
  $('#report-confidence').textContent = ai.confidence + '%';
  $('#report-time').textContent = new Date(ai.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('#overlay-report').classList.remove('hidden');
  document.body.classList.add('no-scroll');
}

function closeReport() {
  $('#overlay-report').classList.add('hidden');
  if (!$('#overlay-add').classList.contains('hidden') || !$('#overlay-proof').classList.contains('hidden')) return;
  document.body.classList.remove('no-scroll');
}

/* ---------- two-step confirm (reset) ---------- */
function twoStep(btn, fn) {
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.textContent = btn.dataset.orig || '';
    fn();
    return;
  }
  btn.dataset.armed = '1';
  btn.dataset.orig = btn.textContent;
  btn.textContent = 'Confirm';
  btn.classList.add('armed');
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.armed) {
      delete btn.dataset.armed;
      btn.classList.remove('armed');
      btn.textContent = btn.dataset.orig || '';
    }
  }, 2600);
}

function handleComplete(btn) {
  const t = taskById(btn.dataset.complete);
  if (!t || t.status !== 'active') return;
  if (isMobile()) openProofFlow(t.id);   // mobile: camera + AI proof (photo-library fallback inside)
  else showPhonePrompt();                // desktop: completion must happen on the phone
}

/* ---------- phone prompt (desktop can't complete tasks) ---------- */
function showPhonePrompt() {
  $('#overlay-phone').classList.remove('hidden');
  document.body.classList.add('no-scroll');
}

function closePhonePrompt() {
  $('#overlay-phone').classList.add('hidden');
  if (!$('#overlay-add').classList.contains('hidden') || !$('#overlay-proof').classList.contains('hidden')) return;
  document.body.classList.remove('no-scroll');
}

/* ---------- event bindings ---------- */
function showLoginError(msg, offerSignup = false) {
  const el = $('#login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  $('#login-to-signup').classList.toggle('hidden', !offerSignup);
}

/* ---------- sign in / create account screen ---------- */
let authMode = 'signin';
const regTouched = new Set();
const regValues = () => ({ name: $('#reg-name').value, username: $('#reg-user').value, password: $('#reg-pass').value, confirm: $('#reg-pass2').value });
const REG_FIELDS = { name: 'reg-name', username: 'reg-user', password: 'reg-pass', confirm: 'reg-pass2' };
const STRENGTH_LABEL = ['Too short', 'Weak', 'Okay', 'Strong'];

function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-tabs .seg-btn').forEach(b => { const on = b.dataset.auth === mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  $('#auth-signin').classList.toggle('hidden', mode !== 'signin');
  $('#auth-signup').classList.toggle('hidden', mode !== 'signup');
  $('#login-error').classList.add('hidden');
  $('#login-to-signup').classList.add('hidden');
  setTimeout(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a.classList.contains('seg-btn')) $(mode === 'signup' ? '#reg-name' : '#login-user').focus();
  }, 30);
}

// Shows a message under each field that has been touched (or every field, after a submit attempt).
function renderRegister(showAll = false) {
  const v = regValues(), errors = validateRegistration(v);
  Object.entries(REG_FIELDS).forEach(([key, id]) => {
    const input = $('#' + id), msg = $('#err-' + id);
    const show = showAll || (regTouched.has(key) && (key !== 'confirm' || v.confirm));
    const bad = show && errors[key];
    input.classList.toggle('invalid', !!bad);
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
    msg.classList.remove('ok');
    msg.textContent = bad ? errors[key] : '';
    if (!bad && key === 'username' && regTouched.has(key) && v.username.trim()) { msg.textContent = 'Available'; msg.classList.add('ok'); }
  });
  const level = passwordStrength(v.password);
  $('#pw-meter').dataset.level = v.password ? level : 0;
  return errors;
}

function bindEvents() {
  // sign in / create account
  $$('.auth-tabs .seg-btn').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));
  $('#login-to-signup').addEventListener('click', () => {
    const typed = $('#login-user').value.trim();
    setAuthMode('signup');
    if (typed) { $('#reg-user').value = typed; regTouched.add('username'); renderRegister(); }
  });
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const u = $('#login-user').value.trim(), p = $('#login-pass').value;
    if (!u || !p) return showLoginError('Enter a username and password.');
    const err = await handleLogin(u, p);
    if (err) showLoginError(err.message, !!err.signup);
  });
  $('#btn-toggle-pass').addEventListener('click', () => {
    const i = $('#login-pass');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('#btn-toggle-pass').textContent = show ? 'Hide' : 'Show';
    $('#btn-toggle-pass').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  // registration: check as people type, after they have visited each field
  Object.entries(REG_FIELDS).forEach(([key, id]) => {
    $('#' + id).addEventListener('input', () => { if (key !== 'confirm' || $('#reg-pass2').value) regTouched.add(key); renderRegister(); });
    $('#' + id).addEventListener('blur', () => { if ($('#' + id).value) { regTouched.add(key); renderRegister(); } });
  });
  $('#btn-toggle-reg-pass').addEventListener('click', () => {
    const show = $('#reg-pass').type === 'password';
    ['#reg-pass', '#reg-pass2'].forEach(sel => { $(sel).type = show ? 'text' : 'password'; });
    $('#btn-toggle-reg-pass').textContent = show ? 'Hide' : 'Show';
    $('#btn-toggle-reg-pass').setAttribute('aria-label', show ? 'Hide passwords' : 'Show passwords');
  });
  $('#register-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errors = await registerAccount(regValues());
    if (!errors) return;
    renderRegister(true);
    const first = Object.keys(REG_FIELDS).find(k => errors[k]);
    $('#' + REG_FIELDS[first]).focus();
  });
  $('#demo-fill').addEventListener('click', () => {
    $('#login-user').value = 'demo';
    $('#login-pass').value = 'demo123';
    $('#login-form').requestSubmit();
  });

  // navigation + logout
  document.addEventListener('click', e => {
    const v = e.target.closest('[data-view]');
    if (v && v !== document.body) showView(v.dataset.view);   // <body> carries the current view in data-view; a click inside it is not navigation
  });
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-logout2').addEventListener('click', logout);

  // appearance
  $('#theme-choice').addEventListener('click', e => { const b = e.target.closest('[data-theme-choice]'); if (b) applyTheme(b.dataset.themeChoice); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener && window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themeChoice() === 'auto') applyTheme('auto'); });
  applyTheme(themeChoice());

  // history: filter, show more
  $('#history-filter').addEventListener('click', e => {
    const b = e.target.closest('[data-hf]');
    if (!b) return;
    historyFilter = b.dataset.hf; historyLimit = 8;
    renderRecord();
  });
  $('#btn-history-more').addEventListener('click', () => { historyLimit += 8; renderRecord(); });
  // history: add funds lives in settings
  $('#btn-add-funds-hero').addEventListener('click', () => showView('settings'));

  // add task
  $('#fab-add').addEventListener('click', () => openAddTask());
  $('#btn-add-task-desktop').addEventListener('click', () => openAddTask());
  $('#btn-add-task-empty').addEventListener('click', () => openAddTask());
  $('#recommended').addEventListener('click', e => {
    const b = e.target.closest('[data-reco]');
    const r = b && RECOMMENDED.find(x => x.name === b.dataset.reco);
    if (r) openAddTask(r);
  });
  $('#btn-done-close').addEventListener('click', closeCelebration);
  $('#overlay-done').addEventListener('click', e => { if (e.target.id === 'overlay-done') closeCelebration(); });
  $('#btn-cancel-add').addEventListener('click', closeAddTask);
  $('#btn-add-guide').addEventListener('click', () => { closeAddTask(); $('#btn-open-guide').click(); });
  $('#overlay-add').addEventListener('click', e => { if (e.target.id === 'overlay-add') closeAddTask(); });
  $('#add-task-form').addEventListener('submit', submitAddTask);
  $('#at-name').addEventListener('input', () => { refine = { base: $('#at-name').value.trim(), picks: {} }; renderRefine(); });   // typing starts the questions over
  $('#at-refine').addEventListener('click', e => { const c = e.target.closest('[data-rq]'); if (c) applyRefine(c.dataset.rq, +c.dataset.ri); });
  ['#at-name', '#at-hours', '#at-minutes', '#at-date', '#at-time'].forEach(sel => $(sel).addEventListener('input', () => { updateDuePreview(); updateAddAssist(); }));
  $('#at-date').addEventListener('input', () => $$('#date-presets .chip').forEach(c => c.classList.remove('active')));
  $$('.seg-btn').forEach(b => b.addEventListener('click', () => setAddMode(b.dataset.mode)));
  $('#date-presets').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c || c.disabled) return;
    if (c.dataset.when) setDateShortcut(c.dataset.when);
    else if (c.dataset.days) setDatePreset(+c.dataset.days);
  });
  $('#at-assist').addEventListener('click', e => {
    if (!e.target.closest('#at-assist-more')) return;
    const r = computeDeadline();
    openHelp({ name: $('#at-name').value.trim() }, addMode === 'duration' && r.ok ? Math.round(r.durationMs / 60000) : undefined);
  });
  $('#btn-help-close').addEventListener('click', closeHelp);
  $('#overlay-help').addEventListener('click', e => { if (e.target.id === 'overlay-help') closeHelp(); });
  $('#duration-presets').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if (c.dataset.custom) { showCustomDuration(true); updateDuePreview(); updateAddAssist(); return; }
    $('#at-hours').value = c.dataset.h;
    $('#at-minutes').value = c.dataset.m;
    showCustomDuration(false);
    $$('#duration-presets [data-h]').forEach(x => x.classList.toggle('active', x === c));
    updateDuePreview();
    updateAddAssist();
  });
  // typing a length by hand keeps "Custom" selected
  ['#at-hours', '#at-minutes'].forEach(sel => $(sel).addEventListener('input', () => { showCustomDuration(true); }));

  // home list: complete / report + charity select (delegated)
  document.addEventListener('click', e => {
    if (e.target.closest('#offer-banner')) { showView('home'); return; }
    const pk = e.target.closest('[data-offer-pick]');
    if (pk) {
      const t = taskById(pk.dataset.offerPick);
      if (t) {
        if (!retryChoices(t).includes(+pk.dataset.ms)) return;
        t.offerChoiceMs = +pk.dataset.ms; saveState();
        $$(`[data-offer-pick="${t.id}"]`).forEach(c => { const on = c === pk; c.classList.toggle('active', on); c.setAttribute('aria-checked', on); });
      }
      return;
    }
    if (e.target.closest('[data-offer-shop]')) return showView('shop');
    const ac = e.target.closest('[data-offer-accept]'); if (ac) return acceptOffer(ac.dataset.offerAccept);
    const dc = e.target.closest('[data-offer-decline]'); if (dc) return declineOffer(dc.dataset.offerDecline);
    const hp = e.target.closest('[data-help]');
    if (hp) { const t = taskById(hp.dataset.help); if (t) openHelp({ name: t.name }, t.byDate ? undefined : Math.round(t.durationMs / 60000)); return; }
    const c = e.target.closest('[data-complete]'); if (c) return handleComplete(c);
    const bl = e.target.closest('[data-bail]'); if (bl) return twoStep(bl, () => bailOut(bl.dataset.bail));
    const br = e.target.closest('[data-buy-retry]'); if (br) return twoStep(br, () => buyRetries(+br.dataset.buyRetry));
    const by = e.target.closest('[data-buy]'); if (by) return twoStep(by, () => buyTickets(+by.dataset.buy));
    const r = e.target.closest('[data-report]'); if (r) openReport(r.dataset.report);
    const s = e.target.closest('[data-select]'); if (s) selectCharity(s.dataset.select);
  });

  // shop deck: swipe, or tap a counter or dot, to bring a card to the front
  let shopRaf = 0;
  $('#shop-items').addEventListener('scroll', () => { cancelAnimationFrame(shopRaf); shopRaf = requestAnimationFrame(markShopCard); }, { passive: true });
  $('#view-shop').addEventListener('click', e => { const b = e.target.closest('[data-shop-card]'); if (b) showShopCard(+b.dataset.shopCard); });

  // settings
  $('#funds-chips').addEventListener('click', e => {
    const c = e.target.closest('[data-amount]');
    if (c) addFunds(c.dataset.amount);
  });
  $('#btn-save-default').addEventListener('click', () => {
    const v = Math.round(+$('#default-penalty').value);
    if (!v || v < MIN_STAKE) return toast(`Minimum stake is ${fmtMoney(MIN_STAKE)}`, 'error');
    if (HTTP) { act(() => API.setDefaultStake(v)).then(r => r && toast('Saved', 'success')); return; }
    state.defaultPenalty = v;
    saveState();
    toast('Saved', 'success');
  });
  $('#btn-reset').addEventListener('click', e => twoStep(e.currentTarget, resetDemoData));

  // proof flow
  $('#btn-pf-cancel').addEventListener('click', closeProofFlow);
  $('#btn-capture').addEventListener('click', captureFromVideo);
  $('#pf-file-fallback').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    pf.image = await downscaleFile(f);
    runAnalysis();
  });
  $('#btn-pf-retake').addEventListener('click', () => {
    pf.image = null;
    showPfStage('camera');
    startCamera();
  });
  $('#btn-pf-done').addEventListener('click', () => {
    const t = taskById(pf.taskId);
    if (!t || !pf.result || pf.result.verdict !== 'verified') return;
    closeProofFlow();
    completeTask(t, { image: pf.image, ai: pf.result });
  });

  // report modal
  $('#btn-close-report').addEventListener('click', closeReport);
  $('#overlay-report').addEventListener('click', e => { if (e.target.id === 'overlay-report') closeReport(); });

  // phone prompt (desktop)
  $('#btn-phone-ok').addEventListener('click', closePhonePrompt);
  $('#overlay-phone').addEventListener('click', e => { if (e.target.id === 'overlay-phone') closePhonePrompt(); });

  // escape closes topmost overlay
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#overlay-help').classList.contains('hidden')) closeHelp();
    else if (!$('#overlay-done').classList.contains('hidden')) closeCelebration();
    else if (!$('#overlay-proof').classList.contains('hidden')) closeProofFlow();
    else if (!$('#overlay-phone').classList.contains('hidden')) closePhonePrompt();
    else if (!$('#overlay-report').classList.contains('hidden')) closeReport();
    else if (!$('#overlay-add').classList.contains('hidden')) closeAddTask();
  });
}

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  if (HTTP) {                                                     // the server holds the session; there is no localStorage account
    bindEvents();
    startTick();
    try { const s = await API.session(); if (s) startServerSession(s); } catch (e) { apiFailure(e); }
    setInterval(() => syncSoon(20000), 30000);                    // also pick up what the worker settled while the tab sat idle
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(5000); });
    return;
  }
  migrateLegacy();
  bindEvents();
  startTick();
  const session = localStorage.getItem(LS_SESSION);
  if (session && getUsers()[session]) {
    startSession(session);
  }
});
