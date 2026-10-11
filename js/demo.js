/* Demo scenes: a small button in the corner of the page that plays a scripted run of clicks over the app.
   Loaded by phone.html (the app runs in its iframe) and by index.html when it is the top page.
   Each scene is a list of steps in SCENES; add a scene by adding a function and a button label. */
'use strict';

(function () {
  if (window.top !== window && !document.documentElement.hasAttribute('data-demo-host')) return;   // inside the phone frame: the outer page owns the button

  const frame = document.querySelector('iframe');
  const app = () => (frame ? frame.contentDocument : document);
  let pace = 1;                                            // scales every wait in a scene: below 1 is faster
  const sleep = ms => new Promise(r => setTimeout(r, ms * pace));
  const appWin = () => (frame ? frame.contentWindow : window);
  let running = false;

  async function waitFor(find, timeout = 5000) {
    const end = Date.now() + timeout;
    for (;;) {
      const found = find();
      if (found) return found;
      if (Date.now() > end) throw new Error('demo: element not found');
      await sleep(60);
    }
  }
  const visible = el => el && !el.closest('.hidden') && el.getClientRects().length > 0;
  const q = sel => () => [...app().querySelectorAll(sel)].find(visible) || null;

  // A visible pointer glides to the target, presses down, ripples and clicks.
  function pointer(doc) {
    let c = doc.getElementById('demo-pointer');
    if (c) return c;
    c = doc.createElement('div');
    c.id = 'demo-pointer';
    c.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-3 6z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    c.style.cssText = 'position:fixed;left:50%;top:100%;width:34px;height:34px;z-index:99999;pointer-events:none;transition:left .8s cubic-bezier(.4,0,.2,1),top .8s cubic-bezier(.4,0,.2,1),transform .15s;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))';
    doc.body.appendChild(c);
    return c;
  }

  // fast: for two-step buttons (Bail out / Buy, then Confirm), where Confirm times out after about 2.6 seconds.
  async function tap(target, fast = false) {
    const el = typeof target === 'string' ? await waitFor(q(target)) : target;
    const doc = el.ownerDocument;
    const box = el.getBoundingClientRect(), vh = doc.defaultView.innerHeight;
    if (box.top < 0 || box.bottom > vh) {                  // only scroll when it is off screen
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(fast ? 150 : 500);
    }
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const cur = pointer(doc);
    const glide = (fast ? .4 : .8) * pace;
    cur.style.transitionDuration = `${glide}s,${glide}s,.15s`;
    cur.style.left = x + 'px'; cur.style.top = y + 'px';
    await sleep(fast ? 500 : 950);                                      // glide there
    cur.style.transform = 'scale(.8)';                     // press
    const ring = doc.createElement('div');
    ring.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35),inset 0 0 0 1px rgba(0,0,0,.2);pointer-events:none;z-index:99998;transition:transform .7s,opacity .7s`;
    doc.body.appendChild(ring);
    setTimeout(() => { ring.style.transform = 'scale(2.6)'; ring.style.opacity = '0'; }, 40);
    setTimeout(() => ring.remove(), 800);
    await sleep(fast ? 120 : 250);
    el.click();
    cur.style.transform = '';
    await sleep(350);
    if (!fast) await sleep(900);
  }

  // Taps the field, then types into it a character at a time (replacing whatever was there).
  async function type(sel, value) {
    const el = await waitFor(q(sel));
    await tap(el);
    el.focus();
    el.value = '';
    for (const ch of value) {
      el.value += ch;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(70);
    }
    el.dispatchEvent(new Event('blur'));
    await sleep(300);
  }

  const pick = list => list[Math.floor(Math.random() * list.length)];
  // A different person every run: name from two lists, username from the name plus digits (2 to 20 letters or numbers).
  function newPerson() {
    const first = pick(['Maya', 'Noah', 'Lena', 'Omar', 'Ivy', 'Leo', 'Zoe', 'Ravi', 'Nora', 'Theo', 'Aya', 'Finn']);
    const last = pick(['Rivera', 'Okafor', 'Lindqvist', 'Haddad', 'Brooks', 'Tanaka', 'Moreau', 'Novak', 'Patel', 'Silva']);
    const username = (first + last.slice(0, 3)).toLowerCase() + Math.floor(Math.random() * 9000 + 1000);
    return { name: `${first} ${last}`, username, password: pick(['Sunny', 'Maple', 'River', 'Cobalt']) + '-' + Math.floor(Math.random() * 900 + 100) + '-go' };
  }

  /* ---------- title above the phone ---------- */
  let titleEl = null;
  function showTitle(text) {
    hideTitle(true);
    titleEl = document.createElement('div');
    titleEl.textContent = text;
    const host = document.querySelector('.stage');
    titleEl.style.cssText = (host
      ? 'position:absolute;left:50%;bottom:100%;margin-bottom:14px;'
      : 'position:fixed;left:50%;top:12px;z-index:2147483646;') +
      'white-space:nowrap;padding:8px 20px;border-radius:999px;font:700 18px system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,#22e6b0,#3b9bff 55%,#a05cff);box-shadow:0 6px 24px rgba(0,0,0,.4);' +
      'opacity:0;transform:translateX(-50%) translateY(12px) scale(.85);transition:opacity .5s,transform .5s cubic-bezier(.2,1.4,.4,1)';
    (host || document.body).appendChild(titleEl);
    const t = titleEl;
    setTimeout(() => { t.style.opacity = 1; t.style.transform = 'translateX(-50%)'; }, 40);
  }
  function hideTitle(now) {
    const t = titleEl; titleEl = null;
    if (!t) return;
    if (now) return t.remove();
    t.style.opacity = 0; t.style.transform = 'translateX(-50%) translateY(-8px)';
    setTimeout(() => t.remove(), 600);
  }

  // Keeps the browser's password manager and autofill out of the registration form.
  // Password fields become plain text fields drawn as dots, so the browser does not treat them as passwords.
  function quietForm() {
    const d = app();
    d.querySelectorAll('#register-form input').forEach(i => {
      i.setAttribute('autocomplete', 'off');
      i.setAttribute('data-lpignore', 'true');          // LastPass
      i.setAttribute('data-1p-ignore', '');             // 1Password
      i.setAttribute('data-bwignore', 'true');          // Bitwarden
      i.setAttribute('data-form-type', 'other');        // Dashlane
      if (i.type === 'password') { i.type = 'text'; i.style.webkitTextSecurity = 'disc'; }
    });
  }

  /* ---------- speech bubble beside the phone: why we are doing this ---------- */
  let bubbleEl = null;
  function say(text, icon = '💡') {
    const html = `<div style="font:700 11px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;opacity:.65;margin-bottom:6px">Why we're doing this</div><div style="display:flex;gap:10px;align-items:flex-start"><span style="font-size:22px;line-height:1">${icon}</span><span>${text}</span></div>`;
    if (!bubbleEl) {
      const host = document.querySelector('.stage');
      const r = host ? host.getBoundingClientRect() : { left: 0, right: 0, top: 80, height: 0 };
      const right = !host || innerWidth - r.right >= r.left;          // side with more room
      bubbleEl = document.createElement('div');
      bubbleEl.style.cssText = 'position:' + (host ? 'absolute' : 'fixed') + ';' + (host ? (right ? 'left:100%;margin-left:30px;' : 'right:100%;margin-right:30px;') + 'top:28%;' : 'left:12px;top:60px;') +
        'width:280px;padding:16px 18px;border-radius:20px;font:500 15px/1.45 system-ui,sans-serif;color:#fff;background:rgba(22,27,25,.94);border:1px solid rgba(255,255,255,.18);box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:2147483646;' +
        'opacity:0;transform:translateX(' + (right ? '-14px' : '14px') + ') scale(.94);transition:opacity .4s,transform .45s cubic-bezier(.2,1.3,.4,1)';
      const tail = document.createElement('i');                          // little tail pointing at the phone
      tail.style.cssText = 'position:absolute;top:34px;width:14px;height:14px;background:rgba(22,27,25,.94);' + (right ? 'left:-8px;border-left:1px solid rgba(255,255,255,.18);border-bottom:1px solid rgba(255,255,255,.18);' : 'right:-8px;border-right:1px solid rgba(255,255,255,.18);border-top:1px solid rgba(255,255,255,.18);') + 'transform:rotate(45deg)';
      const body = document.createElement('div');
      bubbleEl.append(tail, body);
      (host || document.body).appendChild(bubbleEl);
      const b = bubbleEl;
      setTimeout(() => { b.style.opacity = 1; b.style.transform = 'none'; }, 40);
    }
    const body = bubbleEl.lastChild;
    body.style.transition = 'opacity .25s';
    body.style.opacity = 0;
    setTimeout(() => { body.innerHTML = html; body.style.opacity = 1; }, 260);
  }
  function hideSay() {
    const b = bubbleEl; bubbleEl = null;
    if (!b) return;
    b.style.opacity = 0;
    setTimeout(() => b.remove(), 500);
  }

  // The demo is built around the gym: take the gym task's button when there is one, else the first.
  const gymBtn = attr => {
    const btns = [...app().querySelectorAll(`[${attr}]`)].filter(visible);
    return btns.find(b => /gym/i.test((b.closest('.task-card') || {}).textContent || '')) || btns[0] || null;
  };

  /* ---------- Scene 1: Let's get to know each other ----------
     The person is about to finish registering: press "Create account", then go through each onboarding question to the end. */
  async function scene1() {
    const d = app();
    // registration form (filled in here with a new name and username each run)
    if (visible(d.getElementById('view-login')) && !visible(d.getElementById('register-form'))) await tap('[data-auth="signup"]');
    if (visible(d.getElementById('register-form'))) {
      quietForm();
      const me = newPerson();
      await type('#reg-name', me.name);
      await type('#reg-user', me.username);
      await type('#reg-pass', me.password);
      await type('#reg-pass2', me.password);
      await sleep(1000);
      await tap('#register-form button[type="submit"]');
    }

    // onboarding: welcome, then each question
    await waitFor(q('#overlay-onb #onb-next'));
    say('The AI takes your input to give you your personalized tasks.', '🤖');
    await sleep(1200);
    await tap('#onb-next');                                // Get started

    const answers = [                                      // which options to tick on each question, by position
      [0],                                                 // what to work on: get fitter
      [4],                                                 // what gets in the way: I lose motivation
      [2],                                                 // when are you free: evenings
      [1]                                                  // stake: $15
    ];
    for (const picks of answers) {
      await waitFor(q('#onb-stage .tile'));
      await sleep(900);
      const tiles = [...d.querySelectorAll('#onb-stage .tile')];
      if (!tiles.some(t => t.classList.contains('on'))) for (const i of picks) await tap(tiles[i]);
      await sleep(700);
      await tap('#onb-next');                              // Continue / See suggestions
    }

    // suggestions: the defaults are already ticked, so confirm them
    await waitFor(q('#onb-stage .pick-main'));
    await sleep(1800);
    await tap('#onb-next');                                // Start N tasks
  }

  /* ---------- Scene 2: Get it done ----------
     From Today, complete the gym task: Complete, take the photo, wait for the check, confirm, close the celebration. */
  async function scene2() {
    const d = app();
    if (!q('[data-complete]')()) await tap('[data-view="home"]');
    await sleep(800);
    await tap(await waitFor(() => gymBtn('data-complete')));   // Complete on the gym task

    for (let attempt = 0; attempt < 3; attempt++) {
      await waitFor(q('#btn-capture'));
      await sleep(1800);                                   // let the viewfinder settle
      await tap('#btn-capture');                           // take the photo
      say('The AI now analyzes the validity of your evidence.', '🔍');
      // the check takes a few seconds; it ends on Complete (verified) or Retake (rejected)
      const end = await waitFor(() => visible(d.getElementById('btn-pf-done')) ? 'done' : visible(d.getElementById('btn-pf-retake')) ? 'retake' : null, 15000);
      await sleep(1800);                                   // show the verdict
      if (end === 'done') break;
      await tap('#btn-pf-retake');
    }
    await tap('#btn-pf-done');

    await waitFor(q('#btn-done-close'));
    await sleep(2500);                                     // enjoy the celebration
    await tap('#btn-done-close');
  }

  /* ---------- Scene 3: Bail out ----------
     Get a ticket from the Shop, squeeze a task's timer down to a minute, and spend the ticket instead of losing the stake. */
  async function scene3() {
    const d = app();
    const st = code => appWin().eval(code);
    if (!q('[data-bail]')()) await tap('[data-view="home"]');
    await waitFor(q('[data-bail]'));
    say('Sometimes you plan a task and life gets in the way. A bail-out ticket is the safety net.', '🎫');
    await sleep(4500);

    // 1. a ticket from the Shop (skipped when they already have one)
    if (+st('state.tickets') < 1) {
      say('You need a ticket first. Tickets are cheap and never expire, and you can buy more in the Shop any time.', '🛒');
      await tap('[data-view="shop"]');
      await waitFor(q('[data-buy="1"]'));
      await sleep(1500);
      const buy = q('[data-buy="1"]')();
      if (!buy.disabled) { await tap(buy, true); await tap('[data-buy="1"]', true); }   // Buy, then Confirm
      else st('state.tickets = 1; saveState(); renderAll()');                // not enough balance in the demo account
      await sleep(1500);
      await tap('[data-view="home"]');
    }

    // 2. the timer runs down to a minute
    await waitFor(q('[data-bail]'));
    const id = (await waitFor(() => gymBtn('data-bail'))).dataset.bail;
    say('Only a minute left, the gym is closing and you are truly stuck. Normally the stake would go to charity.', '⏳');
    st(`(function (id) { const t = state.tasks.find(x => x.id === id); t.deadline = Date.now() + 60000; saveState(); renderAll(); })(${JSON.stringify(id)})`);
    await sleep(5000);

    // 3. spend the ticket
    say('Instead, tap Bail out and confirm. One ticket clears the task.', '👆');
    await tap(`[data-bail="${id}"]`, true);              // Bail out
    await tap(`[data-bail="${id}"]`, true);              // Confirm, quickly: it times out
    await sleep(1500);
    say('Done. You keep your stake, nothing goes to charity, and it does not count as a miss. Need more? You can buy more tickets in the Shop any time.', '✅');
    await sleep(7500);                                    // a longer message to read
  }

  /* ---------- Scene 4: Not sure what to pick? ----------
     Open "Get ideas", answer the AI assistant's four questions, claim the first partner offer and start it as a task. */
  async function scene4() {
    const d = app();
    if (!q('#btn-open-guide')()) await tap('[data-view="home"]');
    say('Not sure what to pick? The AI assistant can suggest a task for you.', '🤔');
    await sleep(3500);
    await tap('#btn-open-guide');                          // Get ideas

    // the chat asks about right now: mood, place, time, direction
    const answers = [0, 1, 2, 0];                          // full of energy, out and about, an hour, more of what I do (gym)
    const chip = () => [...d.querySelectorAll('#guide-chips .chip')].find(c => !c.disabled && !c.dataset.end && visible(c));
    for (let i = 0; i < answers.length; i++) {
      const first = await waitFor(chip, 15000);
      if (i === 0) say('It asks about right now: your mood, where you are and how much time you have.', '💬');
      await sleep(1500);
      const chips = [...d.querySelectorAll('#guide-chips .chip')].filter(c => !c.disabled && !c.dataset.end);
      await tap(chips[answers[i]] || first);
      await sleep(600);
    }

    // ideas that fit, partner offers first
    await waitFor(q('[data-guide-start]'), 20000);
    pace = .65;                                            // the ideas part moves along faster
    say('Then it builds ideas that fit your answers, with offers from partners first.', '✨');
    await sleep(2500);
    say('Partner offers are limited, and picked just for you. Claim one before it is gone.', '🎁');
    await sleep(1800);                                     // time to read it
    await tap('[data-guide-claim]');                       // Claim offer on the first partner
    await waitFor(q('#add-task-form button[type="submit"]'));
    say('Claiming it fills in your task. Show the code at the partner to get the deal.', '🏷️');
    await sleep(2500);
    await tap('#add-task-form button[type="submit"]');     // Start the task
    await sleep(2500);
  }

  /* ---------- the buttons ---------- */
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483647;display:flex;gap:6px';
  document.body.appendChild(bar);

  function addButton(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'padding:4px 9px;font:600 11px system-ui,sans-serif;color:#fff;background:rgba(40,44,42,.85);border:1px solid rgba(255,255,255,.25);border-radius:999px;cursor:pointer;opacity:.7';
    b.onmouseenter = () => { if (!b.disabled) b.style.opacity = 1; };
    b.onmouseleave = () => { if (!b.disabled) b.style.opacity = .7; };
    b.onclick = () => onClick(b);
    bar.appendChild(b);
    return b;
  }

  // One button per scene; each shows its title above the phone while it plays.
  const SCENES = [
    { label: 'scene1', title: "Let's get to know each other", play: scene1, pace: .55 },
    { label: 'scene2', title: 'Prove it, keep your stake', play: scene2 },
    { label: 'scene3', title: 'Stuck? Bail out', play: scene3 },
    { label: 'scene4', title: 'Not sure what to pick?', play: scene4 }
  ];
  const buttons = [];
  const lock = on => buttons.forEach(b => { b.disabled = on; b.style.opacity = on ? .4 : .7; });

  async function runScene(sc) {
    const t0 = Date.now();
    showTitle(sc.title);
    app().documentElement.classList.add('demo-playing');   // hides the touch dot
    pace = sc.pace || 1;
    try { await sc.play(); } catch (e) { console.warn(e.message); }
    pace = 1;
    console.debug(`demo: ${sc.label} played in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    app().documentElement.classList.remove('demo-playing');
    await sleep(1200);                                     // short hold on the final state
    hideTitle(); hideSay();
    await sleep(300);
    return (Date.now() - t0) / 1000;
  }

  SCENES.forEach(sc => buttons.push(addButton(sc.label, async () => {
    if (running) return;
    running = true; lock(true);
    await runScene(sc);
    running = false; lock(false);
  })));

  // Full screen for the whole page (the phone frame included); press again to leave.
  const full = addButton('full screen', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(e => console.warn(e.message));
  });
  document.addEventListener('fullscreenchange', () => { full.textContent = document.fullscreenElement ? 'exit full screen' : 'full screen'; });

  // Timer in the bottom-left corner: counts while "run all" plays, then stays as the report.
  const clock = document.createElement('div');
  clock.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;padding:5px 11px;border-radius:12px;font:600 12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(40,44,42,.85);border:1px solid rgba(255,255,255,.25);display:none;white-space:pre';
  document.body.appendChild(clock);
  const mmss = sec => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

  // Run all: go full screen, give the layout a moment to settle, then play every scene in order.
  const all = addButton('run all', async () => {
    if (running) return;
    running = true; lock(true);
    const start = Date.now();
    clock.style.display = 'block';
    const tickClock = setInterval(() => { clock.textContent = '⏱ ' + mmss((Date.now() - start) / 1000); }, 250);
    if (!document.fullscreenElement) await Promise.race([document.documentElement.requestFullscreen().catch(e => console.warn(e.message)), sleep(3000)]);   // never wait on it for long
    await sleep(1500);
    const times = [];
    for (const sc of SCENES) { times.push(await runScene(sc)); await sleep(300); }
    clearInterval(tickClock);
    const total = (Date.now() - start) / 1000;
    clock.textContent = `⏱ Run all: ${mmss(total)} (${total.toFixed(1)}s)\n` + SCENES.map((sc, i) => `${sc.label} ${mmss(times[i])}`).join(' · ');
    console.info(clock.textContent);
    running = false; lock(false);
  });
  buttons.push(all);
})();
