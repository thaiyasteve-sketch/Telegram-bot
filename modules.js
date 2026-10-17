'use strict';
// Telegram ports of the WhatsApp-side commands. Every command that targets a group
// works like /kickall: you send the command, pick an admin group, and the action runs.
const crypto = require('crypto');
const { Markup } = require('telegraf');
const store = require('./store');

module.exports = function createModules(core, guard) {
  const { S, bot, panel, escapeHtml: esc, sleep, progressBar, updateMessage, userPart, myIds, isMe, isAdminP } = core;
  const html = { parse_mode: 'HTML' };
  const MAX_TIMER_MS = 30 * 86400000;
  const code = (s) => `<code>${esc(s)}</code>`;

  /* ---------------- shared helpers ---------------- */
  // Edits one Telegram message in place (falls back to sending a new one).
  function makeOut(chatId, messageId = null) {
    let last = null;
    return {
      get messageId() { return messageId; },
      async set(text, extra = html) {
        if (text === last) return null;
        last = text;
        if (messageId != null) {
          const r = await updateMessage(chatId, messageId, text, extra);
          if (r) return r;
        }
        const sent = await bot.telegram.sendMessage(chatId, text, extra).catch(() => null);
        if (sent) messageId = sent.message_id;
        return sent;
      },
    };
  }
  const usage = (title, lines, footer = '') => ({
    usage: panel(title, `<b>Usage</b>\n${lines.map((l) => l).join('\n')}${footer ? `\n\n<i>${footer}</i>` : ''}`),
  });
  const targetLine = (g) => `<b>Target:</b> ${esc(g.name)}`;
  const onOff = (v) => (v ? '🟢 ON' : '🔴 OFF');
  const num = (s) => String(s || '').replace(/\D/g, '');

  function parseDuration(s) {
    const m = String(s || '').toLowerCase().match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const value = parseInt(m[1], 10);
    return { value, unit: m[2], ms: value * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]] };
  }
  const unitName = { s: 'second(s)', m: 'minute(s)', h: 'hour(s)', d: 'day(s)' };
  const clock = (ms) => {
    if (ms <= 0) return '00:00:00';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))}`;
  };

  /* ---------------- /closetime & /opentime ---------------- */
  const timers = new Map(); // id -> { rec, timeout, edit }
  const timerKeyboard = (id) => Markup.inlineKeyboard([[Markup.button.callback('✖  CANCEL TIMER', `timer_cancel:${id}`)]]);

  function timerText(rec) {
    const closing = rec.kind === 'close';
    const total = rec.at - rec.start;
    const remaining = rec.at - Date.now();
    const elapsed = Math.min(Math.max(total - remaining, 0), total);
    const pct = total ? Math.floor((elapsed / total) * 100) : 100;
    return panel(closing ? 'GROUP CLOSING COUNTDOWN' : 'GROUP OPENING COUNTDOWN',
      `${targetLine({ name: rec.name })}\n<code>[${progressBar(elapsed, total, 16)}] ${pct}%</code>\n<code>REMAINING  ${clock(remaining)}</code>\n<code>${closing ? 'CLOSES' : 'OPENS'} AT  ${new Date(rec.at).toISOString().slice(11, 19)} UTC</code>\n\n<i>The group will be ${closing ? 'closed (admins only)' : 'opened (everyone can send)'} automatically.</i>`);
  }

  function armTimer(t) {
    // setTimeout overflows past ~24.8 days, so long timers re-arm in chunks
    const wait = Math.max(0, Math.min(t.rec.at - Date.now(), 2000000000));
    t.timeout = setTimeout(() => (t.rec.at - Date.now() > 1000 ? armTimer(t) : fireTimer(t.rec.id)), wait);
  }

  function startTimer(rec) {
    const t = { rec, timeout: null, edit: null };
    timers.set(rec.id, t);
    const total = rec.at - rec.start;
    const every = total <= 60000 ? 5000 : total <= 600000 ? 30000 : total <= 3600000 ? 60000 : 300000;
    t.edit = setInterval(() => {
      if (rec.at - Date.now() <= 0) return;
      updateMessage(rec.chatId, rec.messageId, timerText(rec), { ...html, ...timerKeyboard(rec.id) });
    }, every);
    armTimer(t);
  }

  function stopTimer(id) {
    const t = timers.get(id);
    if (!t) return null;
    clearTimeout(t.timeout);
    clearInterval(t.edit);
    timers.delete(id);
    store.removeTimer(id);
    return t.rec;
  }

  async function fireTimer(id) {
    const t = timers.get(id);
    if (!t) return;
    clearTimeout(t.timeout);
    clearInterval(t.edit);
    timers.delete(id);
    const rec = t.rec;
    let err = 'The WhatsApp link stayed offline.';
    for (let i = 0; i < 7; i++) {
      if (!S.connected) { await sleep(10000); continue; }
      try {
        await S.sock.groupSettingUpdate(rec.jid, rec.kind === 'close' ? 'announcement' : 'not_announcement');
        err = null;
      } catch (e) { err = e?.message || 'unknown error'; }
      break;
    }
    store.removeTimer(id);
    const closing = rec.kind === 'close';
    const text = err
      ? panel('TIMER FAILED', `${targetLine({ name: rec.name })}\n\n${esc(err)}\n\n<i>Make sure the linked account is still a group admin.</i>`)
      : panel(closing ? 'GROUP CLOSED' : 'GROUP OPENED', `${targetLine({ name: rec.name })}\n<code>[${progressBar(1, 1, 16)}] 100%</code>\n\n✅ Timer finished. ${closing ? 'Only admins can send messages.' : 'All members can send messages.'}`);
    if (!await updateMessage(rec.chatId, rec.messageId, text)) core.notify(text, html);
  }

  bot.action(/^timer_cancel:(\w+)$/, async (ctx) => {
    const cur = timers.get(ctx.match[1])?.rec;
    if (cur && ctx.from.id !== core.OWNER_ID && ctx.from.id !== cur.by) return ctx.answerCbQuery('Only the owner or whoever started it can cancel').catch(() => {});
    const rec = stopTimer(ctx.match[1]);
    await ctx.answerCbQuery(rec ? 'Timer cancelled' : 'Timer already finished').catch(() => {});
    if (!rec) return;
    return ctx.editMessageText(panel('TIMER CANCELLED', `${targetLine({ name: rec.name })}\n\nNo change was made to the group.`), html).catch(() => {});
  });

  let restored = false;
  function restoreTimers() { // timers survive restarts; overdue ones fire right away
    if (restored) return;
    restored = true;
    for (const rec of store.listTimers()) if (!timers.has(rec.id)) startTimer(rec);
  }

  function timerModule(kind) {
    const closing = kind === 'close';
    const cmd = closing ? 'closetime' : 'opentime';
    return {
      aliases: closing ? ['ct', 'closeafter', 'gcclose'] : ['ot', 'openafter', 'gcopen'],
      desc: closing ? 'Close a group after a countdown' : 'Open a group after a countdown',
      prepare(args) {
        const help = usage(closing ? 'CLOSE TIME' : 'OPEN TIME', [
          `/${cmd} 30s — 30 seconds`, `/${cmd} 7m — 7 minutes`, `/${cmd} 3h — 3 hours`, `/${cmd} 2d — 2 days`,
        ], `Pick the group afterwards. Maximum 30 days. A cancel button stays on the countdown.`);
        if (!args.length) return help;
        const d = parseDuration(args[0]);
        if (!d) return { usage: panel('INVALID DURATION', 'Use a number plus <code>s</code>, <code>m</code>, <code>h</code> or <code>d</code>, e.g. <code>30s</code>, <code>7m</code>, <code>3h</code>, <code>2d</code>.') };
        if (d.ms <= 0) return { usage: panel('INVALID DURATION', 'Duration must be greater than zero.') };
        if (d.ms > MAX_TIMER_MS) return { usage: panel('INVALID DURATION', 'Maximum duration is 30 days.') };
        return { args: [args[0].toLowerCase()] };
      },
      async run({ g, args, out, chatId, ctx }) {
        const d = parseDuration(args[0]);
        for (const t of [...timers.values()]) { // a new timer replaces an older one of the same kind for this group
          if (t.rec.jid === g.id && t.rec.kind === kind) {
            const old = stopTimer(t.rec.id);
            updateMessage(old.chatId, old.messageId, panel('TIMER REPLACED', `${targetLine({ name: old.name })}\n\nSuperseded by a newer timer.`));
          }
        }
        const now = Date.now();
        const rec = { id: crypto.randomBytes(3).toString('hex'), jid: g.id, name: g.name, kind, start: now, at: now + d.ms, chatId, messageId: null, by: ctx?.from?.id };
        await out.set(timerText(rec), { ...html, ...timerKeyboard(rec.id) });
        rec.messageId = out.messageId;
        store.addTimer(rec);
        startTimer(rec);
      },
    };
  }

  /* ---------------- /approve ---------------- */
  const approve = {
    aliases: [],
    desc: 'Approve pending join requests',
    prepare(args) {
      if (!args.length) return { args: [] };
      const a = args[0].toLowerCase();
      if (a === 'all' || (/^\d+$/.test(a) && parseInt(a, 10) > 0)) return { args: [a] };
      return usage('APPROVE REQUESTS', ['/approve — show the pending count for a group', '/approve all — approve every request', '/approve 25 — approve the first 25 requests']);
    },
    async run({ g, args, out }) {
      await out.set(panel('JOIN REQUESTS', `${targetLine(g)}\n\nFetching pending requests…`));
      let pending;
      try { pending = await S.sock.groupRequestParticipantsList(g.id); }
      catch (e) { return out.set(panel('FETCH FAILED', esc(e.message))); }
      const total = pending?.length || 0;
      if (!args.length) {
        return out.set(panel('JOIN REQUESTS', `${targetLine(g)}\n<code>PENDING  ${total}</code>\n\n<b>Usage</b>\n/approve all — approve every request\n/approve 25 — approve the first 25`));
      }
      if (!total) return out.set(panel('NO PENDING REQUESTS', targetLine(g)));
      const take = args[0] === 'all' ? total : Math.min(parseInt(args[0], 10), total);
      const ids = pending.slice(0, take).map((r) => r.jid).filter(Boolean);
      let approved = 0;
      const failed = [];
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        try {
          const res = await S.sock.groupRequestParticipantsUpdate(g.id, chunk, 'approve');
          approved += Array.isArray(res) ? res.filter((r) => String(r.status) === '200').length : chunk.length;
        } catch (e) { failed.push(e.message); }
        const done = Math.min(i + chunk.length, ids.length);
        await out.set(panel('APPROVING REQUESTS', `${targetLine(g)}\n<code>[${progressBar(done, ids.length)}] ${Math.floor((done / ids.length) * 100)}%</code>\n\nApproved: <b>${approved}</b>`));
        if (i + 50 < ids.length) await sleep(1500);
      }
      return out.set(panel('APPROVAL COMPLETE', `${targetLine(g)}\n\nRequested: <b>${ids.length}</b>\nApproved: <b>${approved}</b>\nStill pending: <b>${Math.max(0, total - approved)}</b>${failed.length ? `\n\nFailed batches: ${failed.length}\nFirst error: ${esc(failed[0])}` : ''}`));
    },
  };

  /* ---------------- /demote ---------------- */
  const demote = {
    aliases: ['removeadmin'],
    desc: 'Demote a group admin by phone number',
    prepare(args) {
      const n = num(args.join(''));
      if (n.length < 7) return usage('DEMOTE ADMIN', ['/demote 2348012345678 — phone number with country code'], 'Then pick the group. The number must belong to a current admin.');
      return { args: [n] };
    },
    async run({ g, args, out }) {
      const n = args[0];
      let meta;
      try { meta = await S.sock.groupMetadata(g.id); }
      catch (e) { return out.set(panel('DEMOTE FAILED', esc(e.message))); }
      const p = meta.participants.find((x) => {
        const ids = [x.id, x.lid, x.phoneNumber, x.jid].filter(Boolean).map(userPart).map(num);
        return ids.some((d) => d === n || (d.length >= 9 && n.length >= 9 && d.slice(-9) === n.slice(-9)));
      });
      if (!p) return out.set(panel('MEMBER NOT FOUND', `${targetLine(g)}\n\n<code>+${esc(n)}</code> is not a current member of this group.`));
      if (isMe(p, myIds())) return out.set(panel('DEMOTE BLOCKED', 'The linked account cannot demote itself.'));
      if (p.admin === 'superadmin') return out.set(panel('DEMOTE BLOCKED', `${targetLine(g)}\n\nThe group creator cannot be demoted.`));
      if (!isAdminP(p)) return out.set(panel('NOT AN ADMIN', `${targetLine(g)}\n\n<code>+${esc(n)}</code> is not an admin.`));
      try {
        await S.sock.groupParticipantsUpdate(g.id, [p.id], 'demote');
        return out.set(panel('ADMIN DEMOTED', `${targetLine(g)}\n\n🔽 <code>+${esc(n)}</code> is no longer an admin.`));
      } catch (e) { return out.set(panel('DEMOTE FAILED', esc(e.message))); }
    },
  };

  /* ---------------- /ban (global list, no group needed) ---------------- */
  const ban = {
    aliases: ['blockuser', 'banuser'],
    desc: 'Manage the ban list',
    global: true,
    prepare(args) {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'list' || sub === 'show') return { args: ['list'] };
      if (['remove', 'unban', 'off'].includes(sub)) {
        const n = num(args.slice(1).join(''));
        if (n.length < 6) return usage('BAN LIST', ['/ban remove 2348012345678 — unban a number']);
        return { args: ['remove', n] };
      }
      const n = num(args.join(''));
      if (n.length < 6) {
        return usage('BAN LIST', ['/ban 2348012345678 — ban a number', '/ban list — show banned numbers', '/ban remove 2348012345678 — unban'],
          'Banned numbers are removed automatically whenever they join a group where the linked account is admin.');
      }
      return { args: ['add', n] };
    },
    async run({ args, out }) {
      const [sub, n] = args;
      if (sub === 'list') {
        const all = store.bannedList();
        if (!all.length) return out.set(panel('BAN LIST', '<i>No numbers are banned.</i>'));
        return out.set(panel(`BAN LIST (${all.length})`, all.map((x, i) => `${i + 1}. <code>+${esc(x)}</code>`).join('\n') + '\n\n<i>/ban remove &lt;number&gt; to unban.</i>'));
      }
      if (sub === 'remove') {
        if (!store.isBanned(n)) return out.set(panel('NOT BANNED', `<code>+${esc(n)}</code> is not on the ban list.`));
        store.setBanned(n, false);
        return out.set(panel('USER UNBANNED', `🔓 <code>+${esc(n)}</code> was removed from the ban list.`));
      }
      if (store.isBanned(n)) return out.set(panel('ALREADY BANNED', `<code>+${esc(n)}</code> is already on the ban list.`));
      store.setBanned(n, true);
      return out.set(panel('USER BANNED', `🔒 <code>+${esc(n)}</code> added to the ban list.\n\nThey will be removed automatically if they join a group where the linked account is admin.`));
    },
  };

  /* ---------------- settings modules ---------------- */
  const hits = (g, f) => store.violations(g.id, f);

  const antilink = {
    aliases: ['nolink', 'antilinks'],
    desc: 'Anti-link protection for a group',
    prepare(args) {
      const a = (args[0] || '').toLowerCase();
      if (['on', 'off', 'strict', 'status', 'delete', 'kick', 'mute'].includes(a)) return { args: [a] };
      return usage('ANTI-LINK', [
        '/antilink on — delete links, warn, then mute after 3 warnings',
        '/antilink strict — delete and kick on the first link',
        '/antilink delete|kick|mute — punishment after max warnings',
        '/antilink off — disable', '/antilink status — show settings',
      ], 'Detects http/https and www links, short links, WhatsApp/Telegram/Discord invites, bare domains and obfuscated links. Admins are exempt. The linked account must be admin.');
    },
    async run({ g, args, out }) {
      const a = args[0];
      const s = store.getGroup(g.id);
      let title = 'ANTI-LINK STATUS';
      if (a === 'on') { store.setGroupMany(g.id, { antilink: true, antilinkMode: 'normal', antilinkAction: 'mute', antilinkMaxWarnings: 3, antilinkCooldown: 24 }); title = 'ANTI-LINK ENABLED'; }
      else if (a === 'off') { store.setGroupMany(g.id, { antilink: false, antilinkMode: 'off' }); title = 'ANTI-LINK DISABLED'; }
      else if (a === 'strict') { store.setGroupMany(g.id, { antilink: true, antilinkMode: 'strict', antilinkAction: 'kick' }); title = 'ANTI-LINK STRICT MODE'; }
      else if (['delete', 'kick', 'mute'].includes(a)) { store.setGroupMany(g.id, { antilink: true, antilinkAction: a }); title = 'ANTI-LINK ACTION UPDATED'; }
      const state = !s.antilink ? '🔴 OFF' : s.antilinkMode === 'strict' ? '🔴 STRICT' : '🟢 ON';
      const note = a === 'strict' ? '\n\n⚠️ <i>Links are deleted and the sender is kicked on the first violation.</i>' : '';
      return out.set(panel(title, `${targetLine(g)}\n<code>STATUS    ${state}\nMODE      ${(s.antilinkMode || 'normal').toUpperCase()}\nACTION    ${(s.antilinkAction || 'warn').toUpperCase()}\nMAX WARN  ${s.antilinkMaxWarnings || 3}\nCOOLDOWN  ${s.antilinkCooldown || 24}h\nHITS      ${hits(g, 'antilink')}</code>${note}`));
    },
  };

  const antimention = {
    aliases: ['antitag', 'nomentions'],
    desc: 'Anti mass-mention protection',
    prepare(args) {
      const a = (args[0] || '').toLowerCase();
      if (['on', 'off', 'strict', 'status'].includes(a)) return { args: [a] };
      return usage('ANTI-MENTION', [
        '/antimention on — delete and warn at 5+ mentions',
        '/antimention strict — delete and kick at 3+ mentions',
        '/antimention off — disable', '/antimention status — show settings',
      ], 'Detects mass mentions and spam tagging. Admins are exempt. The linked account must be admin.');
    },
    async run({ g, args, out }) {
      const a = args[0];
      const s = store.getGroup(g.id);
      let title = 'ANTI-MENTION STATUS';
      if (a === 'on') { store.setGroupMany(g.id, { antimention: true, antimentionMode: 'normal', antimentionAction: 'warn', antimentionMax: 5 }); title = 'ANTI-MENTION ENABLED'; }
      else if (a === 'off') { store.setGroupMany(g.id, { antimention: false, antimentionMode: 'off' }); title = 'ANTI-MENTION DISABLED'; }
      else if (a === 'strict') { store.setGroupMany(g.id, { antimention: true, antimentionMode: 'strict', antimentionAction: 'kick', antimentionMax: 3 }); title = 'ANTI-MENTION STRICT MODE'; }
      const state = !s.antimention ? '🔴 OFF' : s.antimentionMode === 'strict' ? '🔴 STRICT' : '🟢 ON';
      const note = a === 'strict' ? '\n\n⚠️ <i>Violators are kicked from the group.</i>' : '';
      return out.set(panel(title, `${targetLine(g)}\n<code>STATUS    ${state}\nMODE      ${(s.antimentionMode || 'normal').toUpperCase()}\nACTION    ${(s.antimentionAction || 'warn').toUpperCase()}\nMAX TAGS  ${s.antimentionMax || 5}\nHITS      ${hits(g, 'antimention')}</code>${note}`));
    },
  };

  const antigroupmention = {
    aliases: ['agm', 'notagall', 'antigmention'],
    desc: 'Block @everyone / group-wide mentions',
    prepare(args) {
      const a = (args[0] || '').toLowerCase();
      if (['on', 'off', 'get', 'status', 'reset'].includes(a)) return { args: [a] };
      if (a === 'set') {
        const v = (args[1] || '').toLowerCase();
        if (['delete', 'kick'].includes(v)) return { args: ['set', v] };
        return usage('SET ACTION', ['/antigroupmention set delete — delete the message', '/antigroupmention set kick — kick the sender']);
      }
      return usage('ANTI-GROUP MENTION', [
        '/antigroupmention on — enable (delete)', '/antigroupmention off — disable',
        '/antigroupmention set delete|kick — choose the action',
        '/antigroupmention status — show settings', '/antigroupmention reset — reset the violation counter',
      ], 'Detects @everyone, group mentions and mass member tagging. Admins are exempt. Shortcut: /agm.');
    },
    async run({ g, args, out }) {
      const [a, v] = args;
      const s = store.getGroup(g.id);
      let title = 'AGM STATUS';
      if (a === 'on') {
        if (s.antigroupmention) return out.set(panel('ALREADY ENABLED', `${targetLine(g)}\n\nCurrent action: <b>${(s.antigroupmentionAction || 'delete').toUpperCase()}</b>\nUse /agm set delete|kick to change it.`));
        store.setGroupMany(g.id, { antigroupmention: true, antigroupmentionAction: 'delete' });
        store.resetViolations(g.id, 'antigroupmention');
        title = 'PROTECTION ENABLED';
      } else if (a === 'off') { store.setGroup(g.id, 'antigroupmention', false); title = 'PROTECTION DISABLED'; }
      else if (a === 'set') { store.setGroupMany(g.id, { antigroupmentionAction: v, antigroupmention: true }); title = 'ACTION UPDATED'; }
      else if (a === 'reset') { store.resetViolations(g.id, 'antigroupmention'); title = 'VIOLATIONS RESET'; }
      return out.set(panel(title, `${targetLine(g)}\n<code>STATUS      ${onOff(s.antigroupmention)}\nACTION      ${(s.antigroupmentionAction || 'delete').toUpperCase()}\nVIOLATIONS  ${hits(g, 'antigroupmention')}\nEXEMPT      ADMINS</code>`));
    },
  };

  const antibot = {
    aliases: ['nobot', 'antibots'],
    desc: 'Detect and remove other bots',
    prepare(args) {
      const a = (args[0] || '').toLowerCase();
      if (['on', 'off', 'kick', 'warn', 'status', 'scan'].includes(a)) return { args: [a] };
      return usage('ANTI-BOT', [
        '/antibot on — warn on the first detection, kick on the second',
        '/antibot kick — kick on the first detection',
        '/antibot warn — warn only', '/antibot off — disable',
        '/antibot scan — scan the group now and remove suspected bots', '/antibot status — show settings',
      ], 'Detects multi-device bot accounts on join, well-known bot commands and bot menu signatures. Admins and the linked account are exempt.');
    },
    async run({ g, args, out }) {
      const a = args[0];
      const s = store.getGroup(g.id);
      if (a === 'scan') {
        await out.set(panel('SCANNING FOR BOTS', `${targetLine(g)}\n\nChecking every member…`));
        try {
          const meta = await S.sock.groupMetadata(g.id);
          const ids = myIds();
          const found = meta.participants.filter((p) => !isMe(p, ids) && !isAdminP(p) && guard.isMdBotJid(p.id));
          if (!found.length) return out.set(panel('NO BOTS DETECTED', `${targetLine(g)}\n\nScanned ${meta.participants.length} members. The group looks clean.`));
          let removed = 0;
          for (const p of found) {
            try { await S.sock.groupParticipantsUpdate(g.id, [p.id], 'remove'); removed++; } catch { /* keep going */ }
            await sleep(600);
          }
          return out.set(panel('SCAN COMPLETE', `${targetLine(g)}\n\nSuspected: <b>${found.length}</b>\nRemoved: <b>${removed}</b>`));
        } catch (e) { return out.set(panel('SCAN FAILED', esc(e.message))); }
      }
      let title = 'ANTI-BOT STATUS';
      if (a === 'off') { store.setGroup(g.id, 'antibot', false); title = 'ANTI-BOT DISABLED'; }
      else if (a === 'on') { store.setGroupMany(g.id, { antibot: true, antibotMode: 'kick' }); title = 'ANTI-BOT ENABLED'; }
      else if (a === 'kick') { store.setGroupMany(g.id, { antibot: true, antibotMode: 'instant' }); title = 'ANTI-BOT ENABLED'; }
      else if (a === 'warn') { store.setGroupMany(g.id, { antibot: true, antibotMode: 'warn' }); title = 'ANTI-BOT ENABLED'; }
      const mode = { kick: 'WARN, THEN KICK', instant: 'INSTANT KICK', warn: 'WARN ONLY' }[s.antibotMode || 'kick'];
      return out.set(panel(title, `${targetLine(g)}\n<code>STATUS  ${onOff(s.antibot)}\nMODE    ${mode}\nHITS    ${hits(g, 'antibot')}</code>`));
    },
  };

  function contentModerationModule(feature, titleLabel, aliases = []) {
    const key = feature;
    const title = titleLabel.toUpperCase();
    return {
      aliases,
      desc: `${titleLabel} moderation (delete, warn or kick)`,
      prepare(args) {
        const a = (args[0] || 'status').toLowerCase();
        if (['on', 'off', 'delete', 'warn', 'kick', 'status'].includes(a)) return { args: [a] };
        return usage(title, [
          `/${feature} on — enable; delete prohibited ${titleLabel === 'antisticker' ? 'stickers' : titleLabel === 'antiviewonce' ? 'view-once messages' : 'media'}`,
          `/${feature} delete — delete only`,
          `/${feature} warn — delete and warn the sender`,
          `/${feature} kick — delete and remove the sender`,
          `/${feature} off — disable`, `/${feature} status — show settings`,
        ], 'Admins and the linked account are exempt. The linked WhatsApp account must be a group admin.');
      },
      async run({ g, args, out }) {
        const a = args[0] || 'status';
        const enabledKey = key;
        const actionKey = `${key}Action`;
        let heading = `${title} STATUS`;
        if (a === 'on') {
          store.setGroupMany(g.id, { [enabledKey]: true, [actionKey]: 'delete' });
          heading = `${title} ENABLED`;
        } else if (a === 'off') {
          store.setGroup(g.id, enabledKey, false);
          heading = `${title} DISABLED`;
        } else if (['delete', 'warn', 'kick'].includes(a)) {
          store.setGroupMany(g.id, { [enabledKey]: true, [actionKey]: a });
          heading = `${title} ACTION UPDATED`;
        }
        const s = store.getGroup(g.id);
        return out.set(panel(heading, `${targetLine(g)}\\n<code>STATUS    ${onOff(s[enabledKey])}
ACTION    ${(s[actionKey] || 'delete').toUpperCase()}
VIOLATIONS  ${hits(g, key)}
EXEMPT    ADMINS</code>

<b>Actions</b>
delete — remove the message
warn — delete and warn the sender
kick — delete and remove the sender`));
      },
    };
  }

  const antisticker = contentModerationModule('antisticker', 'antisticker', ['nosticker', 'antistickers']);
  const antimedia = contentModerationModule('antimedia', 'antimedia', ['nomedia', 'antimedias']);
  const antiviewonce = contentModerationModule('antiviewonce', 'antiviewonce', ['noviewonce', 'antiview']);

  const antihijack = {
    aliases: ['adminguard', 'antidemote'],
    desc: 'Reverse unauthorized promote/demote',
    prepare(args) {
      const a = (args[0] || '').toLowerCase();
      if (['on', 'off', 'status'].includes(a)) return { args: [a] };
      return usage('ANTI-HIJACK', ['/antihijack on — lock the admin hierarchy', '/antihijack off — disable', '/antihijack status — show settings'],
        'Reverses any promote or demote not made by the linked account or the group creator, and demotes the offender. The linked account must be admin.');
    },
    async run({ g, args, out }) {
      const a = args[0];
      let title = 'ANTI-HIJACK STATUS';
      if (a === 'on') { store.setGroup(g.id, 'antihijack', true); title = 'ANTI-HIJACK ENABLED'; }
      else if (a === 'off') { store.setGroup(g.id, 'antihijack', false); title = 'ANTI-HIJACK DISABLED'; }
      const on = !!store.getGroup(g.id).antihijack;
      return out.set(panel(title, `${targetLine(g)}\n<code>PROTECTION  ${onOff(on)}\nRETRIES     3 × 400ms\nAUTHORIZED  LINKED ACCOUNT, GROUP CREATOR</code>`));
    },
  };

  const registry = {
    closetime: timerModule('close'), opentime: timerModule('open'),
    approve, demote, ban, antilink, antimention, antigroupmention, antibot, antisticker, antimedia, antiviewonce, antihijack,
  };

  return { registry, restoreTimers, makeOut };
};
