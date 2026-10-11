/* Commit — client for the optional Flask backend (see backend/).
   Off by default: the app runs on localStorage + MOCK exactly as before. Turn the API on with ?api=1, off with ?api=0. It is remembered for this tab only (sessionStorage),
   so a later plain run of the project, with no backend, never finds the switch still on.
   The server answers with an object shaped like the client's own `state`; this file converts it (cents to dollars, server clock
   to this browser's clock) so every render function keeps working unchanged. */
'use strict';

const API = (function () {
  const KEY = 'commit_api';
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q === '1') sessionStorage.setItem(KEY, '1');
    else if (q === '0') sessionStorage.removeItem(KEY);
  } catch (e) { /* storage blocked: stay in local mode */ }
  const on = (() => { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } })();

  class ApiError extends Error {
    constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
  }

  // The server's clock and this browser's differ a little. Shift server times into local time when reading,
  // and back when sending, so the existing Date.now() countdown code stays correct.
  let skew = 0, skewSet = false;
  const toLocal = t => (t == null ? t : t - skew);
  const toServer = t => t + skew;
  const dollars = c => c / 100;
  const cents = d => Math.round(d * 100);

  async function call(method, path, body, idemKey) {
    let res;
    try {
      res = await fetch('/api/v1' + path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(idemKey ? { 'Idempotency-Key': idemKey } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {})
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK', 'Cannot reach the server');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(res.status, err.code || 'ERROR', err.message || 'Something went wrong', err.details);
    }
    return data;
  }

  const TASK_TIMES = ['createdAt', 'deadline', 'offerExpiresAt', 'missedAt', 'completedAt', 'failedAt', 'bailedAt'];
  function hydrateTask(t) {
    const o = { ...t, penalty: dollars(t.penalty) };
    TASK_TIMES.forEach(k => { if (o[k] != null) o[k] = toLocal(o[k]); });
    if (o.charged != null) o.charged = dollars(o.charged);
    if (o.proof) o.proof = { ...o.proof, ai: { ...o.proof.ai, at: toLocal(o.proof.ai.at) } };
    return o;
  }

  function hydrate(s) {
    const offset = s.serverNow - Date.now();                          // includes the round trip, which varies per call,
    if (!skewSet || Math.abs(offset - skew) > 2000) { skew = offset; skewSet = true; }   // so only move it for a real clock difference
    return {
      ...s,
      balance: dollars(s.balance),
      spendable: dollars(s.spendable),
      totalSent: dollars(s.totalSent),
      defaultPenalty: dollars(s.defaultPenalty),
      charities: s.charities.map(c => ({ ...c, raised: dollars(c.raised), goal: dollars(c.goal) })),
      tasks: s.tasks.map(hydrateTask),
      activity: s.activity.map(a => ({ ...a, at: toLocal(a.at) }))
    };
  }

  // Every mutation resolves to { result, state } with state already converted.
  const mutate = async (method, path, body, key) => {
    const r = await call(method, path, body, key);
    return { result: r.result, state: hydrate(r.state) };
  };

  // Signed in? Resolves to the state, or null when there is no session.
  async function session() {
    try { return hydrate((await call('GET', '/state')).state); }
    catch (e) { if (e.status === 401) return null; throw e; }
  }
  async function sync() { return hydrate((await call('GET', '/state')).state); }

  const taskBody = t => ({ name: t.name, icon: t.icon, byDate: !!t.byDate, deadline: toServer(t.deadline), stakeCents: cents(t.penalty) });

  return {
    on, ApiError, session, sync,
    register: v => mutate('POST', '/auth/register', { name: v.name, username: v.username, password: v.password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    login: (username, password) => mutate('POST', '/auth/login', { username, password }),
    logout: () => call('POST', '/auth/logout', {}),
    createTask: (t, key) => mutate('POST', '/tasks', taskBody(t), key),
    createTasks: (list, key) => mutate('POST', '/tasks/batch', { tasks: list.map(taskBody) }, key),
    bail: id => mutate('POST', `/tasks/${id}/bail`, {}),
    retry: (id, durationMs) => mutate('POST', `/tasks/${id}/retry`, { durationMs }),
    decline: id => mutate('POST', `/tasks/${id}/decline`, {}),
    proof: (id, image) => mutate('POST', `/tasks/${id}/proof`, { image }),
    buy: (item, qty, key) => mutate('POST', '/shop/purchases', { item, qty }, key),
    addFunds: (amount, key) => mutate('POST', '/wallet/topups', { amountCents: cents(amount) }, key),
    setCharity: charityId => mutate('PUT', '/me/charity', { charityId }),
    setDefaultStake: amount => mutate('PATCH', '/me/settings', { defaultStakeCents: cents(amount) }),
    setProfile: (profile, onboarded, defaultStake) => mutate('PUT', '/me/profile', { profile, onboarded, ...(defaultStake ? { defaultStakeCents: cents(defaultStake) } : {}) }),
    reset: () => mutate('POST', '/me/reset', {})
  };
})();
