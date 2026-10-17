'use strict';
// Small JSON-backed store (replaces the `utils/database` module the original
// WhatsApp-side commands relied on). Lives next to the WhatsApp login in the project root.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'settings.json');
const data = { groups: {}, banned: {}, timers: [], access: { users: {}, blocked: {}, requests: {}, publicEnabled: false } };

try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const k of Object.keys(data)) if (saved[k] !== undefined) data[k] = saved[k];
} catch { /* first run */ }
for (const k of ['users', 'blocked', 'requests']) data.access[k] = data.access[k] || {};
if (typeof data.access.publicEnabled !== 'boolean') data.access.publicEnabled = false;

let pending = null;
function flush() {
  if (pending) { clearTimeout(pending); pending = null; }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('Settings save failed:', e.message); }
}
function save() { if (!pending) pending = setTimeout(flush, 300); }
process.on('exit', () => { if (pending) flush(); });

const store = {
  flush,

  /* ---- per-group settings ---- */
  peekGroup: (jid) => data.groups[jid] || null, // never creates an entry
  getGroup: (jid) => data.groups[jid] || (data.groups[jid] = {}),
  setGroup(jid, key, value) { store.getGroup(jid)[key] = value; save(); },
  setGroupMany(jid, obj) { Object.assign(store.getGroup(jid), obj); save(); },

  /* ---- violations / warnings ---- */
  bump(jid, feature) {
    const g = store.getGroup(jid);
    g.violations = g.violations || {};
    g.violations[feature] = (g.violations[feature] || 0) + 1;
    save();
    return g.violations[feature];
  },
  violations: (jid, feature) => data.groups[jid]?.violations?.[feature] || 0,
  resetViolations(jid, feature) { store.getGroup(jid).violations = { ...(data.groups[jid].violations || {}), [feature]: 0 }; save(); },
  // Adds a warning for `num`; warnings older than cooldownMs no longer count. Returns the new count.
  addWarn(jid, feature, num, cooldownMs) {
    const g = store.getGroup(jid);
    g.warns = g.warns || {};
    const f = (g.warns[feature] = g.warns[feature] || {});
    const now = Date.now();
    const cur = f[num];
    const n = cur && now - cur.at < cooldownMs ? cur.n + 1 : 1;
    f[num] = { n, at: now };
    save();
    return n;
  },
  clearWarn(jid, feature, num) {
    const f = data.groups[jid]?.warns?.[feature];
    if (f && f[num]) { delete f[num]; save(); }
  },

  /* ---- mutes (bot deletes every message from a muted member) ---- */
  mute(jid, num, until) {
    const g = store.getGroup(jid);
    g.muted = g.muted || {};
    g.muted[num] = until;
    save();
  },
  isMuted(jid, num) {
    const m = data.groups[jid]?.muted;
    if (!m || !m[num]) return false;
    if (m[num] > Date.now()) return true;
    delete m[num];
    if (!Object.keys(m).length) delete data.groups[jid].muted;
    save();
    return false;
  },

  /* ---- ban list ---- */
  isBanned: (num) => !!data.banned[num],
  setBanned(num, on) { if (on) data.banned[num] = true; else delete data.banned[num]; save(); },
  bannedList: () => Object.keys(data.banned),

  /* ---- Telegram access control (who may use the bot) ---- */
  publicAccessEnabled: () => !!data.access.publicEnabled,
  setPublicAccessEnabled(on) { data.access.publicEnabled = !!on; save(); },
  getUser: (id) => data.access.users[id] || null,
  setUser(id, rec) { data.access.users[id] = rec; save(); },
  removeUser(id) { const had = !!data.access.users[id]; delete data.access.users[id]; save(); return had; },
  listUsers: () => Object.entries(data.access.users).map(([id, r]) => ({ id: Number(id), ...r })),
  isBlocked: (id) => !!data.access.blocked[id],
  setBlocked(id, on) { if (on) data.access.blocked[id] = true; else delete data.access.blocked[id]; save(); },
  blockedList: () => Object.keys(data.access.blocked).map(Number),
  setRequest(id, info) { data.access.requests[id] = info; save(); },
  getRequest: (id) => data.access.requests[id] || null,
  clearRequest(id) { delete data.access.requests[id]; save(); },

  /* ---- scheduled open/close timers ---- */
  listTimers: () => data.timers.slice(),
  addTimer(rec) { data.timers.push(rec); save(); },
  updateTimer(id, patch) { const t = data.timers.find((x) => x.id === id); if (t) { Object.assign(t, patch); save(); } },
  removeTimer(id) { data.timers = data.timers.filter((t) => t.id !== id); save(); },
};

module.exports = store;
