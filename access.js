'use strict';
// Who may use the bot. The owner (TELEGRAM_OWNER_ID) has full control; everyone else is
// blocked unless the owner grants premium access. Premium users get the group modules,
// limited to the groups the owner assigns them, and can optionally be allowed /kickall.
const { Markup } = require('telegraf');
const store = require('./store');

// Commands a premium user may run. /kickall needs the per-user `kickall` flag; everything
// not listed here (/ban, access management, WhatsApp pairing) is owner-only.
const PREMIUM_CMDS = new Set([
  'start', 'help', 'status', 'listgroups', 'me',
  'closetime', 'opentime', 'approve', 'demote',
  'antilink', 'antimention', 'antigroupmention', 'antibot', 'antisticker', 'antimedia', 'antihijack',
]);
const UNITS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const DEFAULT_PLAN_MS = 30 * UNITS.d;
const SCOPE_PAGE = 6;

module.exports = function createAccess(core) {
  const { OWNER_ID, bot, panel, escapeHtml: esc, shortLabel, sess, allGroups, S, notify, chunkLines } = core;
  const html = { parse_mode: 'HTML' };
  const isOwner = (id) => id === OWNER_ID;

  /* ---------------- roles & permissions ---------------- */
  const rec = (id) => store.getUser(id);
  const isPremium = (id) => { const r = rec(id); return !!r && (!r.expires || r.expires > Date.now()); };
  const roleOf = (id) => (isOwner(id) ? 'owner' : store.isBlocked(id) ? 'blocked' : isPremium(id) ? 'premium' : 'none');
  function canUse(id, cmd) {
    if (isOwner(id)) return true;
    if (store.isBlocked(id)) return false;
    // Public mode opens normal control/group modules to anyone, but keeps mass-kick
    // and owner-only access-management commands restricted.
    if (store.publicAccessEnabled()) return PREMIUM_CMDS.has(cmd);
    if (!isPremium(id)) return false;
    return PREMIUM_CMDS.has(cmd) || (cmd === 'kickall' && !!rec(id).kickall);
  }
  const scopeOf = (id) => (isOwner(id) ? 'all' : rec(id)?.scope ?? 'all');
  const inScope = (id, jid) => { const s = scopeOf(id); return s === 'all' || (Array.isArray(s) && s.includes(jid)); };
  const filterGroups = (id, groups) => groups.filter((g) => inScope(id, g.id));

  /* ---------------- formatting ---------------- */
  const fullName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || 'Unknown';
  const label = (r, id) => `${esc(r?.name || 'Unknown')}${r?.username ? ` (@${esc(r.username)})` : ''} · <code>${id}</code>`;
  function until(ts) {
    if (!ts) return 'forever';
    const left = Math.ceil((ts - Date.now()) / UNITS.m) * UNITS.m; // round up to the minute so a fresh 30d plan reads "30d"
    if (left <= 0) return 'expired';
    const d = Math.floor(left / UNITS.d), h = Math.floor((left % UNITS.d) / UNITS.h), m = Math.floor((left % UNITS.h) / UNITS.m);
    if (d) return `in ${d}d${h ? ` ${h}h` : ''}`;
    if (h) return `in ${h}h${m ? ` ${m}m` : ''}`;
    return `in ${m}m`;
  }
  const scopeLabel = (s) => (s === 'all' || s == null ? 'ALL GROUPS' : `${s.length} GROUP${s.length === 1 ? '' : 'S'}`);
  function parseDuration(s) {
    s = String(s || '').toLowerCase();
    if (['forever', 'lifetime', 'permanent'].includes(s)) return { forever: true };
    const m = s.match(/^(\d+)(m|h|d|w)$/);
    if (!m || !parseInt(m[1], 10)) return null;
    return { ms: parseInt(m[1], 10) * UNITS[m[2]] };
  }
  const parseId = (s) => { const n = String(s || '').replace(/\D/g, ''); return n.length >= 5 && n.length <= 15 && n === String(s).trim() ? Number(n) : null; };
  function details(r, id) {
    return `<b>User:</b> ${label(r, id)}\n<code>PLAN      PREMIUM\nEXPIRES   ${until(r.expires).toUpperCase()}\nGROUPS    ${scopeLabel(r.scope)}\n/KICKALL  ${r.kickall ? 'ALLOWED' : 'NO'}</code>`;
  }

  /* ---------------- middleware: who gets in ---------------- */
  async function middleware(ctx, next) {
    const id = ctx.from?.id;
    if (!id) return;
    if (isOwner(id)) return next();
    if (store.isBlocked(id)) return; // blocked users are ignored silently
    if (store.publicAccessEnabled() || isPremium(id)) return next();
    if (ctx.callbackQuery?.data === 'req_access') return next();
    if (ctx.chat?.type && ctx.chat.type !== 'private') return;
    console.log(`Access denied for Telegram ID ${id}`);
    const old = rec(id);
    const note = old ? `Your premium access expired${old.expires ? ` on ${new Date(old.expires).toISOString().slice(0, 10)}` : ''}.` : 'This control node is private.';
    return ctx.reply(
      panel('ACCESS RESTRICTED', `${note}\n\nYour Telegram ID: <code>${id}</code>\n\n<i>Tap below to ask the owner for access.</i>`),
      { ...html, ...Markup.inlineKeyboard([[Markup.button.callback('📨  REQUEST ACCESS', 'req_access')]]) },
    ).catch(() => {});
  }
  bot.use(middleware); // registered first so nothing below can be reached without access

  ownerCmd(['publicaccess', 'public'], async (ctx, args) => {
    const mode = String(args[0] || 'status').toLowerCase();
    if (!['on', 'off', 'status'].includes(mode)) {
      return ctx.reply(panel('PUBLIC ACCESS', '<b>Usage</b>\n/publicaccess on — let any non-blocked Telegram user use standard group modules\n/publicaccess off — return to owner-approved access\n/publicaccess status — show current setting'), html);
    }
    if (mode !== 'status') store.setPublicAccessEnabled(mode === 'on');
    const enabled = store.publicAccessEnabled();
    return ctx.reply(panel('PUBLIC ACCESS', `<code>STATUS  ${enabled ? 'ENABLED' : 'DISABLED'}</code>\n\n${enabled ? 'Anyone except blocked users can use standard group-management and moderation commands.' : 'Only the owner and users granted premium access can use the bot.'}\n\n<i>Safety: /kickall and owner-only access controls remain restricted to authorized users.</i>`), html);
  });

  /* ---------------- granting ---------------- */
  async function grant(id, { expires, kickall }, from) {
    const old = rec(id) || {};
    const info = store.getRequest(id);
    let name = old.name || info?.name, username = old.username || info?.username;
    if (!name) {
      const chat = await bot.telegram.getChat?.(id).catch(() => null);
      if (chat) { name = fullName(chat); username = chat.username || username; }
    }
    const r = {
      name: name || 'Unknown', username: username || null,
      expires: expires === undefined ? old.expires ?? null : expires,
      scope: old.scope ?? 'all', kickall: kickall === undefined ? !!old.kickall : kickall,
      addedAt: old.addedAt || Date.now(), addedBy: from,
    };
    store.setUser(id, r);
    store.clearRequest(id);
    const sent = await bot.telegram.sendMessage(id,
      panel('ACCESS GRANTED', `The owner gave you <b>premium</b> access.\n<code>EXPIRES  ${until(r.expires).toUpperCase()}\nGROUPS   ${scopeLabel(r.scope)}</code>\n\n<i>Send /start to open the control panel, or /me to see your access.</i>`), html).catch(() => null);
    return { r, delivered: !!sent };
  }
  const grantKeyboard = (id) => Markup.inlineKeyboard([[
    Markup.button.callback('🎯  CHOOSE GROUPS', `scope_open:${id}`),
    Markup.button.callback('🗑  REVOKE', `acc_revoke:${id}`),
  ]]);
  async function revoke(id, why = 'The owner ended your access.') {
    const had = store.removeUser(id);
    if (had) bot.telegram.sendMessage(id, panel('ACCESS ENDED', why), html).catch(() => {});
    return had;
  }

  /* ---------------- owner commands ---------------- */
  function ownerCmd(names, fn) {
    return bot.command(names, (ctx) => {
      if (!isOwner(ctx.from.id)) return ctx.reply(panel('OWNER ONLY', 'Only the bot owner can manage access.'), html);
      return fn(ctx, ctx.message.text.trim().split(/\s+/).slice(1));
    });
  }
  const ownerAction = (trigger, fn) => bot.action(trigger, async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery('Owner only').catch(() => {});
    return fn(ctx);
  });
  const edit = (ctx, text, extra = html) => ctx.editMessageText(text, extra).catch(() => ctx.reply(text, extra));

  ownerCmd(['grant', 'premium'], async (ctx, args) => {
    const id = parseId(args[0]);
    const help = () => ctx.reply(panel('GRANT ACCESS', `<b>Usage</b>\n/grant 123456789 — premium for 30 days\n/grant 123456789 7d — 12h, 7d, 4w …\n/grant 123456789 forever\n/grant 123456789 30d kickall — also allow /kickall\n\n<i>Get a user's ID from @userinfobot, or let them tap “Request access” and approve from the notification. Running /grant on an existing user updates their plan.</i>`), html);
    if (!id) return help();
    if (isOwner(id)) return ctx.reply(panel('NOT NEEDED', 'That is the owner — they already have full access.'), html);
    let expires, kickall;
    for (const t of args.slice(1)) {
      const a = t.toLowerCase();
      if (a === 'kickall') kickall = true;
      else if (a === 'nokickall') kickall = false;
      else { const d = parseDuration(a); if (!d) return help(); expires = d.forever ? null : Date.now() + d.ms; }
    }
    if (expires === undefined && !rec(id)) expires = Date.now() + DEFAULT_PLAN_MS;
    store.setBlocked(id, false);
    const { r, delivered } = await grant(id, { expires, kickall }, ctx.from.id);
    return ctx.reply(panel('ACCESS GRANTED', `${details(r, id)}${delivered ? '' : '\n\n⚠️ <i>Could not message them — they need to open the bot and press Start once.</i>'}`), { ...html, ...grantKeyboard(id) });
  });

  ownerCmd('revoke', async (ctx, args) => {
    const id = parseId(args[0]);
    if (!id) return ctx.reply(panel('REVOKE ACCESS', '<b>Usage</b>\n/revoke 123456789'), html);
    return ctx.reply(await revoke(id) ? panel('ACCESS REVOKED', `<code>${id}</code> no longer has access.`) : panel('NOT FOUND', `<code>${id}</code> has no premium access.`), html);
  });

  ownerCmd(['block', 'unblock'], async (ctx, args) => {
    const unblock = /^\/unblock/i.test(ctx.message.text);
    const id = parseId(args[0]);
    if (!id || isOwner(id)) return ctx.reply(panel('BLOCK USER', '<b>Usage</b>\n/block 123456789 — revoke access and ignore this user\n/unblock 123456789\n\n<i>This is about Telegram users of the bot. For WhatsApp numbers use /ban.</i>'), html);
    if (unblock) { store.setBlocked(id, false); return ctx.reply(panel('USER UNBLOCKED', `<code>${id}</code> can request access again.`), html); }
    await revoke(id, 'Your access to this control node was removed.');
    store.setBlocked(id, true);
    store.clearRequest(id);
    return ctx.reply(panel('USER BLOCKED', `<code>${id}</code> is blocked and will be ignored.`), html);
  });

  ownerCmd(['users', 'access'], async (ctx) => {
    const users = store.listUsers();
    const blocked = store.blockedList();
    const lines = [panel('ACCESS LIST', `<b>Owner:</b> <code>${OWNER_ID}</code>\n<code>PREMIUM ${users.length}  •  BLOCKED ${blocked.length}</code>`)];
    for (const [i, u] of users.entries()) {
      const exp = u.expires && u.expires <= Date.now() ? '⚠️ expired' : until(u.expires);
      lines.push(`<b>${String(i + 1).padStart(2, '0')}</b>  ${label(u, u.id)}\n      <code>${exp.toUpperCase()}  •  ${scopeLabel(u.scope)}${u.kickall ? '  •  /KICKALL' : ''}</code>`);
    }
    if (!users.length) lines.push('<i>No premium users yet. Use /grant to add one.</i>');
    if (blocked.length) lines.push(`<b>Blocked:</b> ${blocked.map((b) => `<code>${b}</code>`).join(', ')}`);
    lines.push('<i>/grant · /revoke · /scope · /block · /unblock</i>');
    for (const part of chunkLines(lines)) await ctx.reply(part, html);
  });

  bot.command('me', (ctx) => {
    const id = ctx.from.id;
    if (isOwner(id)) return ctx.reply(panel('YOUR ACCESS', '<code>ROLE  OWNER</code>\n\nFull control, including access management, /kickall and /ban.'), html);
    const r = rec(id);
    return ctx.reply(panel('YOUR ACCESS', `<code>ROLE      PREMIUM\nEXPIRES   ${until(r.expires).toUpperCase()}\nGROUPS    ${scopeLabel(r.scope)}\n/KICKALL  ${r.kickall ? 'ALLOWED' : 'NO'}</code>`), html);
  });

  /* ---------------- request access (from the "denied" screen) ---------------- */
  const cooldown = new Map();
  bot.action('req_access', async (ctx) => {
    const u = ctx.from;
    if (isOwner(u.id) || isPremium(u.id)) return ctx.answerCbQuery('You already have access').catch(() => {});
    if (store.isBlocked(u.id)) return;
    if (Date.now() - (cooldown.get(u.id) || 0) < 10 * 60000) return ctx.answerCbQuery('Request already sent — please wait').catch(() => {});
    cooldown.set(u.id, Date.now());
    store.setRequest(u.id, { name: fullName(u), username: u.username || null, at: Date.now() });
    await ctx.answerCbQuery('Request sent to the owner').catch(() => {});
    const id = u.id;
    notify(panel('ACCESS REQUEST', `<b>User:</b> ${label({ name: fullName(u), username: u.username }, id)}\n\n<i>Choose a plan, or deny.</i>`), {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('7 DAYS', `acc_g:${id}:7d`), Markup.button.callback('30 DAYS', `acc_g:${id}:30d`), Markup.button.callback('FOREVER', `acc_g:${id}:forever`)],
        [Markup.button.callback('✖  DENY', `acc_d:${id}`), Markup.button.callback('🚫  BLOCK', `acc_b:${id}`)],
      ]),
    });
    return ctx.reply(panel('REQUEST SENT', 'The owner has been notified. You will get a message here if access is granted.'), html);
  });

  ownerAction(/^acc_g:(\d+):(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery('Access granted').catch(() => {});
    const id = Number(ctx.match[1]);
    const d = parseDuration(ctx.match[2]);
    if (!d) return;
    store.setBlocked(id, false);
    const { r, delivered } = await grant(id, { expires: d.forever ? null : Date.now() + d.ms }, ctx.from.id);
    return edit(ctx, panel('ACCESS GRANTED', `${details(r, id)}${delivered ? '' : '\n\n⚠️ <i>Could not message them.</i>'}`), { ...html, ...grantKeyboard(id) });
  });
  ownerAction(/^acc_d:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Denied').catch(() => {});
    const id = Number(ctx.match[1]);
    store.clearRequest(id);
    bot.telegram.sendMessage(id, panel('REQUEST DECLINED', 'The owner declined your access request.'), html).catch(() => {});
    return edit(ctx, panel('REQUEST DENIED', `<code>${id}</code> was told the request was declined.`));
  });
  ownerAction(/^acc_b:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Blocked').catch(() => {});
    const id = Number(ctx.match[1]);
    store.setBlocked(id, true);
    store.clearRequest(id);
    return edit(ctx, panel('USER BLOCKED', `<code>${id}</code> is blocked and will be ignored. Undo with /unblock ${id}.`));
  });
  ownerAction(/^acc_revoke:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await ctx.answerCbQuery('Access revoked').catch(() => {});
    await revoke(id);
    return edit(ctx, panel('ACCESS REVOKED', `<code>${id}</code> no longer has access.`));
  });

  /* ---------------- group scope picker (which groups a premium user may manage) ---------------- */
  function scopeView(T) {
    const sc = T.scope;
    const start = sc.page * SCOPE_PAGE;
    const items = sc.groups.slice(start, start + SCOPE_PAGE);
    const pages = Math.max(1, Math.ceil(sc.groups.length / SCOPE_PAGE));
    const r = rec(sc.userId);
    const text = panel('CHOOSE GROUPS', `<b>User:</b> ${label(r, sc.userId)}\n<code>SELECTED ${sc.selected.size} / ${sc.groups.length}   •   PAGE ${sc.page + 1} / ${pages}</code>\n\n<i>Tap groups to toggle them, then save. “All groups” also covers groups added later.</i>`);
    const rows = items.map((g, o) => [Markup.button.callback(`${sc.selected.has(g.id) ? '☑' : '☐'}  ${String(start + o + 1).padStart(2, '0')} · ${shortLabel(g.name, 30)}`, `scope_t:${start + o}`)]);
    const nav = [];
    if (sc.page > 0) nav.push(Markup.button.callback('‹  PREV', `scope_p:${sc.page - 1}`));
    if (sc.page < pages - 1) nav.push(Markup.button.callback('NEXT  ›', `scope_p:${sc.page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([Markup.button.callback('🌐  ALL GROUPS', 'scope_all'), Markup.button.callback('💾  SAVE', 'scope_save')]);
    rows.push([Markup.button.callback('✖  CANCEL', 'scope_cancel')]);
    return { text, extra: { ...html, ...Markup.inlineKeyboard(rows) } };
  }
  async function startScope(ctx, userId) {
    const r = rec(userId);
    if (!r) return ctx.reply(panel('NOT FOUND', `<code>${userId}</code> has no premium access. Use /grant first.`), html);
    if (!S.connected) return ctx.reply(panel('LINK REQUIRED', 'WhatsApp is not connected, so groups cannot be listed yet.'), html);
    let groups;
    try { groups = (await allGroups()).filter((g) => g.admin); }
    catch (e) { return ctx.reply(panel('SCAN FAILED', esc(e.message)), html); }
    if (!groups.length) return ctx.reply(panel('NO GROUPS', 'The linked account is not admin in any group.'), html);
    const T = sess(ctx);
    const sel = r.scope === 'all' || r.scope == null ? groups.map((g) => g.id) : r.scope.filter((j) => groups.some((g) => g.id === j));
    T.scope = { userId, groups, selected: new Set(sel), page: 0 };
    const v = scopeView(T);
    return ctx.reply(v.text, v.extra);
  }
  const rerender = (ctx, T) => { const v = scopeView(T); return ctx.editMessageText(v.text, v.extra).catch(() => {}); };
  const needScope = (ctx) => { const T = sess(ctx); if (T.scope) return T; ctx.answerCbQuery('Selection expired — run /scope again').catch(() => {}); return null; };

  ownerCmd('scope', async (ctx, args) => {
    const id = parseId(args[0]);
    if (!id) return ctx.reply(panel('GROUP SCOPE', '<b>Usage</b>\n/scope 123456789 — choose which groups this premium user can manage'), html);
    return startScope(ctx, id);
  });
  ownerAction(/^scope_open:(\d+)$/, async (ctx) => { await ctx.answerCbQuery().catch(() => {}); return startScope(ctx, Number(ctx.match[1])); });
  ownerAction(/^scope_t:(\d+)$/, async (ctx) => {
    const T = needScope(ctx); if (!T) return;
    await ctx.answerCbQuery().catch(() => {});
    const g = T.scope.groups[Number(ctx.match[1])];
    if (g) { if (T.scope.selected.has(g.id)) T.scope.selected.delete(g.id); else T.scope.selected.add(g.id); }
    return rerender(ctx, T);
  });
  ownerAction(/^scope_p:(\d+)$/, async (ctx) => {
    const T = needScope(ctx); if (!T) return;
    await ctx.answerCbQuery().catch(() => {});
    T.scope.page = Number(ctx.match[1]);
    return rerender(ctx, T);
  });
  const finishScope = async (ctx, scope, title) => {
    const T = needScope(ctx); if (!T) return;
    const { userId } = T.scope;
    T.scope = null;
    const r = rec(userId);
    if (!r) return edit(ctx, panel('NOT FOUND', `<code>${userId}</code> no longer has access.`));
    store.setUser(userId, { ...r, scope });
    bot.telegram.sendMessage(userId, panel('GROUPS UPDATED', `You can now manage: <b>${scopeLabel(scope)}</b>.`), html).catch(() => {});
    return edit(ctx, panel(title, details({ ...r, scope }, userId)));
  };
  ownerAction('scope_all', async (ctx) => { await ctx.answerCbQuery('All groups').catch(() => {}); return finishScope(ctx, 'all', 'SCOPE SAVED'); });
  ownerAction('scope_save', async (ctx) => {
    const T = needScope(ctx); if (!T) return;
    await ctx.answerCbQuery('Saved').catch(() => {});
    return finishScope(ctx, [...T.scope.selected], 'SCOPE SAVED');
  });
  ownerAction('scope_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled').catch(() => {});
    sess(ctx).scope = null;
    return edit(ctx, panel('SCOPE UNCHANGED', 'No changes were made.'));
  });

  return { middleware, roleOf, canUse, inScope, filterGroups, scopeOf, isOwner, isPremium, until, scopeLabel };
};
