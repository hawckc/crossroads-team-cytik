/* Commit — onboarding: a short setup, one question per screen, that ends on suggested activities.
   Not a chat. Reuses the guide's questions and suggestion rules (GUIDE) and the task help (ASSIST).
   Loaded after app.js and guide.js; uses their globals ($, esc, fmtMoney, state, uid, toast, saveState, renderAll, showView). */
'use strict';

const ONBOARDING = (function () {
  const E = MOCK.EMOJIS;
  const MAX_AREAS = 3;

  /* ---------- the screens ---------- */
  // Tiles reuse the guide's option data, with a little extra copy for the tile layout.
  const AREA_TILES = [
    { id: 'fitness',  icon: E[0]},
    { id: 'study',    icon: E[4]},
    { id: 'work',     icon: E[2]},
    { id: 'home',     icon: E[3]},
    { id: 'health',   icon: E[7]},
    { id: 'creative', icon: E[8]},
    { id: 'unsure',   icon: '🎲'}
  ];
  const WHEN_ICON = { morning: '🌅', afternoon: '☀️', evening: '🌙', varies: '🔀' };

  const STEPS = [
    { id: 'welcome' },
    { id: 'area', multi: true, title: 'What do you want to work on?' },
    { id: 'blocker', multi: true, title: 'What gets in the way?' },
    { id: 'when', multi: true, title: 'When are you free?' },
    { id: 'stake', title: 'How much will you stake?' },
    { id: 'results' }
  ];

  /* ---------- state ---------- */
  let step = 0;
  let dir = 1;                         // 1 forward, -1 back, for the slide direction
  let sel = {};                        // answers: areas[], blockers[], whens[], stake
  let picks = [];                      // suggested activities on the last screen
  let chosen = new Set();              // indexes of the ones ticked
  let renderToken = 0;
  let guideHTML = '';                  // the robot on the results screen, shown above the footer
  let fresh = false;                   // true right after registration
  let startKey = null;                 // one idempotency key per setup, so a retried start does not create the tasks twice

  const el = id => document.getElementById(id);
  const optionsFor = id => ({ area: GUIDE.AREA.options, blocker: GUIDE.BLOCKER.options, when: GUIDE.WHEN.options, stake: GUIDE.STAKE.options }[id]);
  // The three multiple-choice questions keep a list of answers. One option on each is exclusive.
  const MULTI = { area: { key: 'areas', exclusive: 'unsure' }, blocker: { key: 'blockers', exclusive: null }, when: { key: 'whens', exclusive: 'varies' } };
  // What the venue ranking needs: one time of day and one main blocker, drawn from the lists.
  const prefs = () => ({
    when: sel.whens.length === 1 ? sel.whens[0] : 'varies',
    blocker: sel.blockers.includes('busy') ? 'busy' : sel.blockers.includes('energy') ? 'energy' : sel.blockers[0]
  });

  /* ---------- picking activities ---------- */
  function activities() {
    const areas = sel.areas.includes('unsure') ? ['fitness', 'home', 'study'] : sel.areas;
    const base = { blockers: sel.blockers, whens: sel.whens, stake: sel.stake };
    const lists = areas.map(id => GUIDE.suggest({ ...base, area: { id } }, 3));
    const out = [];
    for (let i = 0; i < 3; i++) {                          // take one from each area in turn
      for (const l of lists) if (l[i] && !out.some(o => o.name === l[i].name)) out.push(l[i]);
    }
    return out.slice(0, 4);
  }

  const lenText = r => r.days ? `${r.days} days` : `${r.h ? r.h + 'h' : ''}${r.m ? (r.h ? ' ' : '') + r.m + 'm' : ''}`;
  const totalStake = () => [...chosen].reduce((sum, i) => sum + picks[i].stake, 0);

  /* ---------- rendering ---------- */
  function tileHTML(t, selected, multi) {
    return `<button type="button" class="tile${selected ? ' on' : ''}" role="${multi ? 'checkbox' : 'radio'}" aria-checked="${selected}" data-v="${esc(String(t.value))}">
      ${t.icon ? `<span class="tile-ico" aria-hidden="true">${t.icon}</span>` : ''}
      <b>${esc(t.label)}</b>${t.hint ? `<small>${esc(t.hint)}</small>` : ''}
      <i class="tile-check" aria-hidden="true"></i>
    </button>`;
  }

  function questionHTML(s, n) {
    let tiles;
    if (s.id === 'area') {
      tiles = AREA_TILES.map(t => tileHTML({ value: t.id, icon: t.icon, label: GUIDE.AREA.options.find(o => o.id === t.id).label }, sel.areas.includes(t.id), true)).join('');
    } else if (s.id === 'stake') {
      tiles = GUIDE.STAKE.options.map(o => tileHTML({ value: o.id, label: o.label }, sel.stake && sel.stake.id === o.id && !sel.customStake, false)).join('');
    } else {
      tiles = optionsFor(s.id).map(o => tileHTML({ value: o.id, label: o.label, icon: s.id === 'when' ? WHEN_ICON[o.id] : '' }, sel[MULTI[s.id].key].includes(o.id), true)).join('');
    }
    const custom = s.id === 'stake'
      ? `<label class="onb-custom"><span>Other amount</span><div><b>$</b><input id="onb-custom-stake" type="number" min="${MIN_STAKE}" max="100" inputmode="numeric" value="${sel.customStake || ''}"/></div></label>`
      : '';
    return `<p class="onb-count">${n} of 4${s.multi ? ', pick any' : ''}</p>
      <h1 id="onb-title">${esc(s.title)}</h1>
      ${s.id === 'stake' ? '<p class="sub onb-note">Your stake is the money you put on the line for each task. Finish it on time and you keep it. Miss the deadline and it goes to your chosen charity.</p>' : ''}
      <div class="tiles${s.multi ? ' multi' : ''}" role="${s.multi ? 'group' : 'radiogroup'}" aria-labelledby="onb-title">${tiles}</div>${custom}`;
  }

  function welcomeHTML() {
    return `<div class="onb-welcome"><span class="ai-logo lg" aria-hidden="true"><svg><use href="#i-ai-bot"/></svg></span>
      <p class="ai-badge lg"><svg aria-hidden="true"><use href="#i-ai-spark"/></svg>AI assistant</p>
      ${fresh ? `<p class="onb-done-pill"><svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Account created</p>` : ''}
      <h1 id="onb-title">${fresh && currentUser ? `Welcome, ${esc(currentUser.name.split(' ')[0])}` : 'Find your tasks'}</h1>
      <p class="sub">Our AI assistant will learn what you want to work on, then suggest tasks, places and plans that fit your week. Four quick questions.</p></div>`;
  }

  async function resultsHTML(token) {
    const ideas = activities();
    // Partner offers go first, highlighted; ticking one starts a task for it like any other pick
    const partners = GUIDE.suggestPartners(ideas, { direction: { id: 'new' } }, 2).map(p => ({ ...p, partner: true, task: p.task }));
    // Starter picks run for days, not hours: partner offers get 3 days, the rest 5
    picks = [...partners.map(p => ({ ...p, partnerName: p.name, name: p.task, days: 3 })), ...ideas.map(r => ({ ...r, days: 5 }))];
    const pf = prefs();
    await Promise.all(picks.filter(r => !r.partner).map(async r => {
      const mins = r.h * 60 + r.m;
      [r.help, r.where] = await Promise.all([ASSIST.load(r, mins, pf), ASSIST.whereFor(r, mins, pf)]);
    }));
    if (token !== renderToken) return null;
    if (!chosen.size) {                                  // default picks: the top partner offer and the first two ordinary ones
      const firstPartner = picks.findIndex(r => r.partner);
      if (firstPartner >= 0) chosen.add(firstPartner);
      picks.forEach((r, i) => { if (!r.partner && [...chosen].filter(j => !picks[j].partner).length < 2) chosen.add(i); });
    }
    const partnerCard = (r, i) => `
      <article class="reco pick partner${chosen.has(i) ? ' on' : ''}" style="--i:${i};--c1:${r.color[0]};--c2:${r.color[1]}">
        <span class="p-ribbon">Partner offer</span>
        <button type="button" class="pick-main" role="checkbox" aria-checked="${chosen.has(i)}" data-pick="${i}">
          ${GUIDE.logoSVG(r)}
          <span class="pick-text"><b>${esc(r.partnerName)}</b><small>${esc(r.detail)}</small></span>
          <span class="reco-meta-inline"><b>${lenText(r)}</b><small>${fmtMoney(r.stake)}</small></span>
          <i class="tile-check" aria-hidden="true"></i>
        </button>
        <div class="p-offer"><b>${esc(r.offer)}</b>${r.was ? `<s>${esc(r.was)}</s>` : ''}</div>
        <div class="p-map hidden">${GUIDE.partnerWhere(r)}</div>
        ${GUIDE.partnerWhere(r) ? '<button type="button" class="link-btn p-route" data-route-toggle aria-expanded="false">Details</button>' : ''}
        <small class="p-terms">${esc(r.terms)} Code <b>${esc(r.code)}</b></small>
      </article>`;
    const cards = picks.map((r, i) => r.partner ? partnerCard(r, i) : `
      <article class="reco pick${chosen.has(i) ? ' on' : ''}" style="--i:${i}">
        <button type="button" class="pick-main" role="checkbox" aria-checked="${chosen.has(i)}" data-pick="${i}">
          <span class="reco-icon" aria-hidden="true">${r.icon}</span>
          <span class="pick-text"><b>${esc(r.name)}</b></span>
          <span class="reco-meta-inline"><b>${lenText(r)}</b><small>${fmtMoney(r.stake)}</small></span>
          <i class="tile-check" aria-hidden="true"></i>
        </button>
        ${ASSIST.whereHTML(r.where, true)}${r.help ? `<button type="button" class="link-btn" data-pick-help="${i}">Details</button>` : ''}
      </article>`).join('');
    const hasHelp = picks.some(r => r.help);
    guideHTML = `<aside class="ai-guide">
        <svg class="ai-guide-bot" viewBox="0 0 64 100" role="img" aria-label="AI assistant robot pointing up">
          <defs><linearGradient id="aig" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22e6b0"/><stop offset=".55" stop-color="#3b9bff"/><stop offset="1" stop-color="#a05cff"/></linearGradient></defs>
          <path d="M26 4v7" stroke="#3b9bff" stroke-width="2.4" stroke-linecap="round"/><circle cx="26" cy="4" r="3.2" fill="#22e6b0"/>
          <rect x="10" y="11" width="32" height="25" rx="10" fill="url(#aig)"/>
          <rect x="15" y="16" width="22" height="15" rx="7" fill="#fff"/>
          <circle cx="22" cy="23" r="2.4" fill="#0b2a3d"/><circle cx="30" cy="23" r="2.4" fill="#0b2a3d"/>
          <path d="M22 27.2c2.4 1.8 5.6 1.8 8 0" stroke="#0b2a3d" stroke-width="1.8" stroke-linecap="round" fill="none"/>
          <rect x="13" y="39" width="26" height="30" rx="9" fill="url(#aig)"/>
          <rect x="19" y="46" width="14" height="10" rx="5" fill="#0b2a3d"/><text x="26" y="54" text-anchor="middle" font-size="8" font-weight="800" fill="#fff" font-family="system-ui,sans-serif">AI</text>
          <path d="M15 45c-5 2-6 9-5 14" stroke="url(#aig)" stroke-width="5.5" stroke-linecap="round" fill="none"/>
          <path d="M37 45c6-2 8-9 6-19" stroke="url(#aig)" stroke-width="5.5" stroke-linecap="round" fill="none"/>
          <circle cx="43" cy="23" r="4" fill="#fff" stroke="url(#aig)" stroke-width="2"/><path d="M43 19v-5" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
          <path d="M20 69v18M32 69v18" stroke="url(#aig)" stroke-width="6" stroke-linecap="round"/>
          <rect x="13" y="87" width="14" height="8" rx="4" fill="#0b2a3d"/><rect x="25" y="87" width="14" height="8" rx="4" fill="#0b2a3d"/>
        </svg>
        <p class="ai-guide-say"><b>AI assistant</b>${hasHelp ? ' Tap <em>Details</em> up there to see places, prices and plans for each pick.' : ''} Want more ideas? Tap <em>Get ideas</em> on Today any time.</p>
      </aside>`;
    return `<h1 id="onb-title">Picked for you</h1>
      <div class="picks">${cards}</div>`;
  }

  async function render() {
    const token = ++renderToken;
    const s = STEPS[step];
    const stage = el('onb-stage');
    const body = s.id === 'welcome' ? welcomeHTML() : s.id === 'results' ? await resultsHTML(token) : questionHTML(s, step);
    if (body === null || token !== renderToken) return;
    el('onb-guide').innerHTML = s.id === 'results' ? guideHTML : '';
    el('overlay-onb').querySelector('.onb-panel').classList.toggle('has-guide', s.id === 'results');
    stage.innerHTML = `<div class="onb-step ${dir < 0 ? 'back' : ''}">${body}</div>`;
    stage.scrollTop = 0;

    // top bar: segmented progress, back button
    const total = STEPS.length - 1;
    el('onb-dots').innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i < step ? 'done' : i === step ? 'now' : ''}"></i>`).join('');
    el('onb-back').classList.toggle('invisible', step === 0);
    el('onb-skip').classList.toggle('hidden', step === STEPS.length - 1);
    refreshFooter();
  }

  function answered() {
    const s = STEPS[step];
    if (s.id === 'welcome') return true;
    if (s.id === 'results') return chosen.size > 0 && totalStake() <= spendable();
    if (MULTI[s.id]) return sel[MULTI[s.id].key].length > 0;
    return !!sel[s.id];
  }

  function refreshFooter() {
    const s = STEPS[step];
    const next = el('onb-next');
    const note = el('onb-note');
    note.textContent = '';
    note.classList.remove('bad');
    if (s.id === 'welcome') next.textContent = 'Get started';
    else if (s.id === 'stake') next.textContent = 'See suggestions';
    else if (s.id === 'results') {
      next.textContent = chosen.size ? `Start ${chosen.size} task${chosen.size > 1 ? 's' : ''}` : 'Choose one';
      if (chosen.size && totalStake() > spendable()) {
        note.textContent = `${fmtMoney(totalStake())} is more than your balance (${fmtMoney(spendable())})`;
        note.classList.add('bad');
      } else if (chosen.size) note.textContent = `${fmtMoney(totalStake())} at stake`;
    } else next.textContent = 'Continue';
    next.disabled = !answered();
  }

  /* ---------- interaction ---------- */
  function choose(value) {
    const s = STEPS[step];
    const paint = on => $$('#onb-stage .tile').forEach(t => { const v = on(t.dataset.v); t.classList.toggle('on', v); t.setAttribute('aria-checked', v); });
    if (MULTI[s.id]) {
      const { key, exclusive } = MULTI[s.id];
      const has = sel[key].includes(value);
      if (exclusive && value === exclusive) sel[key] = has ? [] : [exclusive];
      else {
        let next = sel[key].filter(v => v !== exclusive);              // picking something specific drops the "none of these" option
        if (has) next = next.filter(v => v !== value);
        else if (s.id === 'area' && next.length >= MAX_AREAS) { toast(`Up to ${MAX_AREAS}`, 'info'); return; }
        else next.push(value);
        sel[key] = next;
      }
      paint(v => sel[key].includes(v));
    } else {                                                           // stake: one answer
      sel.stake = GUIDE.STAKE.options.find(o => String(o.id) === value);
      sel.customStake = '';
      el('onb-custom-stake').value = '';
      paint(v => v === value);
    }
    refreshFooter();
  }

  function togglePick(i) {
    chosen.has(i) ? chosen.delete(i) : chosen.add(i);
    const card = document.querySelector(`[data-pick="${i}"]`);
    card.setAttribute('aria-checked', chosen.has(i));
    card.closest('.pick').classList.toggle('on', chosen.has(i));
    refreshFooter();
  }

  function go(delta) {
    dir = delta;
    step = Math.max(0, Math.min(STEPS.length - 1, step + delta));
    render();
  }

  function startChosen() {
    const now = Date.now();
    const list = [...chosen].sort().map(i => picks[i]);
    if (HTTP) return startChosenOnServer(list, now);
    list.forEach(r => {
      const due = new Date(now);
      due.setDate(due.getDate() + r.days);
      due.setHours(18, 0, 0, 0);                          // due that evening, a realistic cut-off
      state.tasks.unshift({ id: uid(), name: r.name, icon: r.icon, status: 'active', byDate: true, createdAt: now, deadline: due.getTime(), durationMs: due.getTime() - now, penalty: r.stake });
    });
    state.defaultPenalty = sel.stake ? sel.stake.id : state.defaultPenalty;      // remember their comfortable stake
    state.profile = { areas: sel.areas, blockers: sel.blockers, whens: sel.whens, blocker: prefs().blocker, when: prefs().when, stake: sel.stake && sel.stake.id };
    saveState();
    finish();
    renderAll();
    showView('home');
    toast(`Started ${list.length}`, 'success');
    list.filter(r => r.partner).forEach(r => toast(`Show code ${r.code} at ${r.partnerName}`, 'success'));
  }

  // With the backend: the tasks and the answers are saved on the server, and the setup is closed once both have gone through.
  async function startChosenOnServer(list, now) {
    const tasks = list.map(r => {
      const due = new Date(now);
      due.setDate(due.getDate() + r.days);
      due.setHours(18, 0, 0, 0);                          // due that evening, a realistic cut-off
      return { name: r.name, icon: r.icon, byDate: true, deadline: due.getTime(), penalty: r.stake };
    });
    const profile = { areas: sel.areas, blockers: sel.blockers, whens: sel.whens, blocker: prefs().blocker, when: prefs().when, stake: sel.stake && sel.stake.id };
    if (tasks.length && !(await act(() => API.createTasks(tasks, startKey || (startKey = uid()))))) return;
    if (!(await act(() => API.setProfile(profile, true, sel.stake && sel.stake.id)))) return;
    finish();
    showView('home');
    toast(`Started ${list.length}`, 'success');
    list.filter(r => r.partner).forEach(r => toast(`Show code ${r.code} at ${r.partnerName}`, 'success'));
  }

  function finish() {
    if (HTTP) {
      if (!state.onboarded) { state.onboarded = true; API.setProfile(null, true).then(r => applyServer(r.state)).catch(() => {}); }
    } else localStorage.setItem(keyFor(LS_ONBOARDED), '1');
    el('overlay-onb').classList.add('hidden');
    document.body.classList.remove('no-scroll');
  }

  function open(opts) {
    fresh = !!(opts && opts.registered);
    startKey = null;
    step = 0; dir = 1; sel = { areas: [], blockers: [], whens: [] }; picks = []; chosen = new Set();
    el('overlay-onb').classList.remove('hidden');
    document.body.classList.add('no-scroll');
    render();
    setTimeout(() => el('overlay-onb').querySelector('.onb-panel').focus(), 40);
  }

  // The robot stays put until the person does something real, then fades for good.
  const dismissGuide = () => { const g = el('onb-guide').firstElementChild; if (g) g.classList.add('gone'); };

  function bind() {
    el('onb-next').addEventListener('click', () => {
      if (!answered()) return;
      dismissGuide();
      STEPS[step].id === 'results' ? startChosen() : go(1);
    });
    el('onb-back').addEventListener('click', () => go(-1));
    el('onb-skip').addEventListener('click', finish);

    el('onb-stage').addEventListener('click', e => {
      const t = e.target.closest('.tile');
      if (t) return choose(t.dataset.v);
      const p = e.target.closest('[data-pick]');
      if (p) { dismissGuide(); return togglePick(+p.dataset.pick); }
      const rt = e.target.closest('[data-route-toggle]');
      if (rt) return GUIDE.toggleRoute(rt);
      const h = e.target.closest('[data-pick-help]');
      if (h) { dismissGuide(); const r = picks[+h.dataset.pickHelp]; openHelp({ name: r.name }, r.h * 60 + r.m, prefs()); }
    });

    // a typed stake overrides the tiles
    el('onb-stage').addEventListener('input', e => {
      if (e.target.id !== 'onb-custom-stake') return;
      const n = Math.round(+e.target.value);
      sel.customStake = e.target.value;
      sel.stake = n >= MIN_STAKE && n <= 100 ? { id: n, label: '$' + n } : null;
      $$('#onb-stage .tile').forEach(t => { t.classList.remove('on'); t.setAttribute('aria-checked', 'false'); });
      refreshFooter();
    });
    el('onb-stage').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'onb-custom-stake') { e.preventDefault(); if (answered()) go(1); }
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !el('overlay-onb').classList.contains('hidden') && el('overlay-help').classList.contains('hidden')) finish();
    });
    const redo = el('btn-redo-onboarding');
    if (redo) redo.addEventListener('click', open);
  }

  document.addEventListener('DOMContentLoaded', bind);
  return { open, finish };
})();
