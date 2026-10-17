// WhatsApp bot controlled from Telegram. NOVA sci-fi control interface.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Telegraf, Markup } = require('telegraf');
const store = require('./store');

// Baileys may be ESM-only, so it is loaded with dynamic import() (works for CJS too)
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, Browsers;
async function loadBaileys() {
  const mod = await import('@whiskeysockets/baileys');
  const b = mod.makeWASocket || (typeof mod.default === 'function' ? mod.default : mod.default?.default) || mod.default;
  makeWASocket = b;
  ({ useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, Browsers } = { ...(mod.default && typeof mod.default === 'object' ? mod.default : {}), ...mod });
}

// ================= CONFIG (env vars) =================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = Number(process.env.TELEGRAM_OWNER_ID || 0);
const KICK_ADMINS = (process.env.KICK_ADMINS || 'true').toLowerCase() === 'true';
const REQUIRE_CONFIRM = (process.env.REQUIRE_CONFIRM || 'true').toLowerCase() === 'true';
// =====================================================

if (!TOKEN || !OWNER_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID. Set them in the panel Startup tab or in a .env file.');
  console.error('Get your numeric Telegram ID from @userinfobot.');
  process.exit(1);
}

const AUTH_DIR = path.join(__dirname, '.whatsapp-auth');
fs.mkdirSync(path.dirname(AUTH_DIR), { recursive: true });

const bot = new Telegraf(TOKEN);
const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notify = (text, extra) => bot.telegram.sendMessage(OWNER_ID, text, extra).catch(() => {});
const PICKER_PAGE_SIZE = 6;
const BRAND = 'EXO FLOODS  //  GROUP OPS';

// WhatsApp link state (shared by everyone)
const S = { sock: null, connected: false, canPair: false, kickRunning: false };

// Per-user picker state, so several people can use the bot at the same time.
// stage: null | 'number' | 'pick' | 'confirm'
const sessions = new Map();
const sess = (ctx) => {
  const id = ctx.from.id;
  if (!sessions.has(id)) sessions.set(id, { stage: null, groups: [], chosen: null, job: null, scope: null, pickerChatId: null, pickerMessageId: null });
  return sessions.get(id);
};
const AUDIT = (process.env.AUDIT_PREMIUM || 'true').toLowerCase() === 'true';

/* ---------------- Interface helpers ---------------- */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortLabel(value, limit = 42) {
  const chars = Array.from(String(value || 'Unnamed group'));
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
}
function panel(title, body = '') {
  return `<b>╭─━━━〔 EXO FLOODS 〕━━━╮</b>\n<b>│  ${title}  │</b>\n<code>╰─━━━━━━━━━━━━━━━━━━━━─╯</code>${body ? `\n\n${body}` : ''}\n\n<i>◈ SECURE GROUP CONTROL  •  COMMAND DECK ◈</i>`;
}
function statusLabel() {
  if (S.connected) return 'ONLINE';
  if (S.sock?.authState?.creds?.registered) return 'RECONNECTING';
  return 'PAIRING REQUIRED';
}
function homeText() {
  const wa = S.connected ? '🟢 WHATSAPP LINK ACTIVE' : (S.sock?.authState?.creds?.registered ? '🟡 WHATSAPP RECONNECTING' : '🔴 WHATSAPP NOT LINKED');
  return panel(BRAND,
    `<code>CONTROL DECK  •  ${statusLabel()}</code>\n${wa}\n\n<b>WELCOME, OPERATOR</b>\n<i>Your group-control modules are ready. Select a station below to scan targets, inspect the link, or review the command guide.</i>\n\n<code>◉ PRIVATE CONTROL  ◉ AUDITED ACTIONS  ◉ SAFE CONFIRMATION</code>`);
}
function homeKeyboard(ctx) {
  const rows = [];
  if (access.canUse(ctx?.from?.id ?? OWNER_ID, 'kickall')) rows.push([Markup.button.callback('SCAN ADMIN GROUPS', 'ui_scan')]);
  rows.push([Markup.button.callback('SYSTEM STATUS', 'ui_status'), Markup.button.callback('GROUP INDEX', 'ui_groups')]);
  rows.push([Markup.button.callback('COMMAND GUIDE', 'ui_help')]);
  return Markup.inlineKeyboard(rows);
}
function helpText(ctx) {
  const uid = ctx?.from?.id ?? OWNER_ID;
  const owner = access.isOwner(uid);
  const kick = access.canUse(uid, 'kickall');
  const lines = ['<b>Quick launch</b>'];
  if (kick) lines.push('/kickall — scan admin groups and choose a target');
  lines.push('/listgroups — inspect your groups', '/status — check the WhatsApp link', '/me — see your access', '/start — open this control panel', '',
    '<b>Group modules</b> <i>(send the command, then pick a group)</i>',
    '/closetime 7m — close the group after a countdown', '/opentime 7m — open it after a countdown',
    '/approve all — approve join requests (or a number)', '/demote 234… — demote an admin by number');
  if (owner) lines.push('/ban 234… — ban list (also: list, remove)');
  lines.push('/antilink on|strict|off|status', '/antimention on|strict|off|status', '/antigroupmention on|off|set|status', '/antibot on|kick|warn|scan|off', '/antisticker on|off|delete|warn|kick|status', '/antimedia on|off|delete|warn|kick|status', '/antiviewonce on|off|delete|warn|kick|status', '/antihijack on|off|status');
  if (owner) lines.push('', '<b>Access control</b>', '/grant 123456789 30d — give premium (7d, forever, kickall)', '/revoke 123456789 — remove premium', '/users — list premium and blocked users', '/scope 123456789 — choose which groups they can manage', '/block · /unblock 123456789 — ignore a Telegram user', '/publicaccess on|off|status — let anyone use standard modules');
  lines.push('', '<b>Operation sequence</b>', '1. Link WhatsApp with the pairing code if prompted.', '2. Tap a group or send its displayed number.', '3. Review the target and confirm or cancel.', '4. Watch live progress in the operation panel.', '',
    '<i>The linked account and group creator are protected. Use only in groups you own or administer.</i>');
  return panel('OPERATOR GUIDE', lines.join('\n'));
}
function statusText(ctx) {
  const wa = S.connected ? '🟢 CONNECTED' : (S.sock?.authState?.creds?.registered ? '🟡 RECONNECTING' : '🔴 NOT LINKED');
  const policy = KICK_ADMINS ? 'Admins: included (creator protected)' : 'Admins: skipped';
  const confirm = REQUIRE_CONFIRM ? 'Safety gate: confirmation required' : 'Safety gate: confirmation disabled';
  return panel('SYSTEM STATUS',
    `<code>TELEGRAM   │  🟢 ONLINE</code>\n<code>WHATSAPP   │  ${wa.replace(/<|>/g, '')}</code>\n<code>POLICY     │  ${escapeHtml(policy)}</code>\n<code>GUARDRAIL  │  ${escapeHtml(confirm)}</code>\n\n<b>OPERATOR ACCESS</b>\n<i>${access.isOwner(ctx?.from?.id ?? OWNER_ID) ? 'Owner clearance · full command access.' : `Premium clearance · ${access.until(store.getUser(ctx.from.id)?.expires)}.`}</i>`);
}
function chunkLines(lines, max = 3500) {
  const out = []; let cur = '';
  for (const line of lines) {
    if ((cur + '\n' + line).length > max) { if (cur) out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}
function jobLabel(job) { return `/${job.cmd}${job.args?.length ? ' ' + job.args.join(' ') : ''}`.toUpperCase(); }
function pageCount(T) { return Math.max(1, Math.ceil(T.groups.length / PICKER_PAGE_SIZE)); }
function pickerText(T, page) {
  const start = page * PICKER_PAGE_SIZE;
  const items = T.groups.slice(start, start + PICKER_PAGE_SIZE);
  const rows = items.map((g, offset) => {
    const n = start + offset + 1;
    return `<b>${String(n).padStart(2, '0')}</b>  ${escapeHtml(shortLabel(g.name, 54))}\n      <code>👥 ${g.size} members  •  ADMIN ACCESS</code>`;
  });
  const mod = T.job && T.job.cmd !== 'kickall' ? `<code>MODULE  •  ${escapeHtml(jobLabel(T.job))}</code>\n` : '';
  return panel('TARGET SELECTION',
    `${mod}<code>PAGE ${page + 1} / ${pageCount(T)}   •   ${T.groups.length} ADMIN GROUP${T.groups.length === 1 ? '' : 'S'}</code>\n\n${rows.join('\n\n')}\n\n<i>Tap a target below, or send its displayed number.</i>`);
}
function pickerKeyboard(T, page) {
  const start = page * PICKER_PAGE_SIZE;
  const items = T.groups.slice(start, start + PICKER_PAGE_SIZE);
  const rows = items.map((g, offset) => [
    Markup.button.callback(`${String(start + offset + 1).padStart(2, '0')}  ·  ${shortLabel(g.name, 32)}`, `group_select:${start + offset}`),
  ]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('‹  PREVIOUS', `group_page:${page - 1}`));
  if (page < pageCount(T) - 1) nav.push(Markup.button.callback('NEXT  ›', `group_page:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('✖  CANCEL SELECTION', 'kick_no')]);
  return Markup.inlineKeyboard(rows);
}
function confirmationText(g) {
  return panel('CONFIRM DESTRUCTIVE ACTION',
    `<code>TARGET      ${escapeHtml(g.name)}</code>\n<code>MEMBERS     ${g.size}</code>\n<code>ADMIN MODE  ${KICK_ADMINS ? 'INCLUDE ADMINS' : 'SKIP ADMINS'}</code>\n\n⚠️ <b>ACTION REQUIRES AUTHORIZATION</b>\n<i>Every eligible member will be removed. The linked account and group creator are protected. This cannot be automatically undone.</i>`);
}
function confirmationKeyboard() {
  return Markup.inlineKeyboard([[
    Markup.button.callback('CONFIRM REMOVAL', 'kick_yes'),
    Markup.button.callback('CANCEL', 'kick_no'),
  ]]);
}
function progressBar(done, total, width = 12) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}
function operationText(g, done, total, removed, failed, label = 'OPERATION IN PROGRESS') {
  const percent = total ? Math.floor((done / total) * 100) : 0;
  return panel(label,
    `<b>Target:</b> ${escapeHtml(g.name)}\n<code>[${progressBar(done, total)}] ${percent}%</code>\n<code>${done} / ${total} processed</code>\n\nRemoved: <b>${removed}</b>  •  Failed: <b>${failed}</b>`);
}
async function updateMessage(chatId, messageId, text, extra = { parse_mode: 'HTML' }) {
  try { return await bot.telegram.editMessageText(chatId, messageId, undefined, text, extra); }
  catch { return null; }
}
function clearPicker(T) {
  T.pickerChatId = null;
  T.pickerMessageId = null;
}

/* ---------------- WhatsApp ---------------- */
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
  });
  S.sock = sock;
  S.canPair = false;
  guard.attach(sock); // antilink / antimention / antibot / antihijack / ban enforcement

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) S.canPair = true; // socket is ready to issue a pairing code
    if (connection === 'open') {
      S.connected = true;
      const num = sock.user?.id?.split(':')[0].split('@')[0];
      console.log('WhatsApp connected as +' + num);
      modules.restoreTimers();
      notify(panel('WHATSAPP LINK ACTIVE', `<code>Account: +${escapeHtml(num)}</code>\n\n<i>Open the NOVA control panel with /start.</i>`), { parse_mode: 'HTML' });
    }
    if (connection === 'close') {
      S.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        notify(panel('LINK SESSION EXPIRED', 'WhatsApp signed out. Send /kickall or tap Scan to link again.'), { parse_mode: 'HTML' });
        setTimeout(startWA, 1000);
      } else {
        setTimeout(startWA, 3000);
      }
    }
  });
}

// Strip server + device suffix: "1234:5@s.whatsapp.net" / "99@lid" -> "1234" / "99"
const userPart = (j) => String(j || '').split('@')[0].split(':')[0];

// All identifiers (phone JID and LID) that belong to the linked WhatsApp account
function myIds() {
  const u = S.sock?.user || {};
  const me = S.sock?.authState?.creds?.me || {};
  return new Set([u.id, u.lid, u.phoneNumber, me.id, me.lid, me.phoneNumber].filter(Boolean).map(userPart));
}
function isMe(p, ids = myIds()) {
  return [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).some((j) => ids.has(userPart(j)));
}
const isAdminP = (p) => p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true;

async function allGroups() {
  const ids = myIds();
  const all = Object.values(await S.sock.groupFetchAllParticipating());
  return all
    .map((g) => {
      const mine = g.participants.find((p) => isMe(p, ids));
      const amOwner = [g.owner, g.ownerPn].filter(Boolean).some((j) => ids.has(userPart(j)));
      const admin = (mine && isAdminP(mine)) || amOwner;
      return { id: g.id, name: g.subject || 'Unnamed group', size: g.participants.length, admin: !!admin, inGroup: !!mine || amOwner };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
async function manageableGroups() {
  return (await allGroups()).filter((g) => g.admin);
}
async function requestPair(number) {
  if (S.sock?.authState?.creds?.registered) throw new Error('Already linked. Wait for it to reconnect.');
  for (let i = 0; i < 20 && !S.canPair; i++) await sleep(500);
  const code = await S.sock.requestPairingCode(number);
  return code.match(/.{1,4}/g).join('-');
}

/* ---------------- Group modules (closetime, antilink, ...) ---------------- */
const core = { S, bot, OWNER_ID, sess, allGroups, chunkLines, panel, escapeHtml, shortLabel, sleep, progressBar, updateMessage, notify, userPart, myIds, isMe, isAdminP };
// Access control must be created first: it installs the auth middleware before any handler below.
const access = require('./access')(core);
const guard = require('./guard')(core);
const modules = require('./modules')(core, guard);

/* ---------------- Telegram control panel ---------------- */
// Access (owner / premium / blocked) is enforced by lib/access.js

async function showHome(ctx) {
  return ctx.reply(homeText(), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
}
async function showStatus(ctx) {
  return ctx.reply(statusText(ctx), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
}
async function showGroupIndex(ctx) {
  if (!S.connected) return ctx.reply(panel('LINK REQUIRED', 'WhatsApp is not connected. Open /start and choose Scan, or send /kickall to link.'), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
  try {
    await ctx.reply(panel('SCANNING GROUP INDEX', 'Querying the linked WhatsApp account…'), { parse_mode: 'HTML' });
    const groups = access.filterGroups(ctx.from.id, await allGroups());
    if (!groups.length) return ctx.reply(panel('INDEX EMPTY', access.isOwner(ctx.from.id) ? 'No WhatsApp groups were found for this account.' : 'No groups are assigned to you yet. Ask the owner.'), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
    const lines = [panel('GROUP INDEX', `<code>${groups.length} GROUP${groups.length === 1 ? '' : 'S'} DETECTED</code>`)];
    for (const [i, g] of groups.entries()) {
      lines.push(`<b>${String(i + 1).padStart(2, '0')}  ${escapeHtml(shortLabel(g.name, 80))}</b>\n   <code>👥 ${g.size} members  •  ${g.admin ? 'ADMIN' : 'MEMBER'}</code>\n   <code>${escapeHtml(g.id)}</code>`);
    }
    for (const part of chunkLines(lines)) await ctx.reply(part, { parse_mode: 'HTML' });
    return ctx.reply(panel('INDEX COMPLETE', `Admin access: ${groups.filter((g) => g.admin).length} / ${groups.length}\n\n<i>Use /kickall to choose an admin group.</i>`), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
  } catch (e) {
    return ctx.reply(panel('SCAN FAILED', escapeHtml(e.message)), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
  }
}
async function showPicker(ctx, page = 0, edit = false) {
  const T = sess(ctx);
  const text = pickerText(T, page);
  const extra = { parse_mode: 'HTML', ...pickerKeyboard(T, page) };
  let sent = null;
  if (edit && T.pickerChatId != null && T.pickerMessageId != null) {
    sent = await updateMessage(T.pickerChatId, T.pickerMessageId, text, extra);
  }
  if (!sent) sent = await ctx.reply(text, extra);
  T.pickerChatId = ctx.chat.id;
  T.pickerMessageId = sent?.message_id ?? T.pickerMessageId;
  return sent;
}
async function beginScan(ctx, job = { cmd: 'kickall', args: [] }) {
  const T = sess(ctx);
  if (S.kickRunning) return ctx.reply(panel('BUSY', 'A removal sequence is already running. Wait for it to finish.'), { parse_mode: 'HTML' });
  if (!S.connected) {
    if (S.sock?.authState?.creds?.registered) return ctx.reply(panel('RECONNECTING', 'WhatsApp is restoring its link. Try again in a few seconds.'), { parse_mode: 'HTML' });
    if (!access.isOwner(ctx.from.id)) return ctx.reply(panel('LINK OFFLINE', 'The bot\'s WhatsApp is not linked right now. Please ask the owner.'), { parse_mode: 'HTML' });
    T.stage = 'number';
    return ctx.reply(panel('PAIR WHATSAPP', 'Send your WhatsApp number with country code (digits only).\n\nExample: <code>919876543210</code>'), { parse_mode: 'HTML' });
  }

  try {
    const scanning = await ctx.reply(panel('SCANNING ADMIN GROUPS', 'Querying your groups and checking admin access…'), { parse_mode: 'HTML' });
    const everything = await allGroups();
    const adminGroups = everything.filter((g) => g.admin);
    const groups = access.filterGroups(ctx.from.id, adminGroups);
    if (!groups.length) {
      T.stage = null;
      if (adminGroups.length) return ctx.reply(panel('NO GROUPS ASSIGNED', 'The owner has not assigned you any groups yet.'), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
      console.log('My ids:', [...myIds()].join(', '), '| groups seen:', everything.length);
      return ctx.reply(panel('NO TARGETS FOUND', `No groups with admin access were found.\nGroups scanned: ${everything.length}\n\nUse /listgroups to inspect all groups.`), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
    }
    T.groups = groups;
    T.stage = 'pick';
    T.chosen = null;
    T.job = job;
    T.pickerChatId = ctx.chat.id;
    T.pickerMessageId = scanning.message_id;
    return showPicker(ctx, 0, true);
  } catch (e) {
    T.stage = null;
    return ctx.reply(panel('SCAN FAILED', escapeHtml(e.message)), { parse_mode: 'HTML', ...homeKeyboard(ctx) });
  }
}
async function chooseGroup(ctx, index) {
  const T = sess(ctx);
  if (T.stage !== 'pick' || !T.groups[index]) {
    return ctx.reply(panel('SELECTION EXPIRED', 'That target selection is no longer active. Start a fresh scan with /kickall.'), { parse_mode: 'HTML' });
  }
  if (!access.inScope(ctx.from.id, T.groups[index].id)) {
    return ctx.reply(panel('NOT ALLOWED', 'You no longer have access to that group.'), { parse_mode: 'HTML' });
  }
  if (T.job && T.job.cmd !== 'kickall') {
    const job = T.job, target = T.groups[index];
    T.stage = null; T.chosen = null; T.job = null;
    return runJob(ctx, job, target);
  }
  T.chosen = T.groups[index];
  const g = T.chosen;
  if (!REQUIRE_CONFIRM) {
    T.stage = null;
    return runKick(ctx);
  }
  T.stage = 'confirm';
  const extra = { parse_mode: 'HTML', ...confirmationKeyboard() };
  const edited = T.pickerChatId != null && T.pickerMessageId != null
    ? await updateMessage(T.pickerChatId, T.pickerMessageId, confirmationText(g), extra)
    : null;
  if (!edited) return ctx.reply(confirmationText(g), extra);
  return edited;
}

bot.start(showHome);
bot.help((ctx) => ctx.reply(helpText(ctx), { parse_mode: 'HTML', ...homeKeyboard(ctx) }));
bot.command('status', showStatus);
const deny = (ctx, cmd) => ctx.reply(panel('NOT AVAILABLE', cmd === 'kickall' ? 'Your plan does not include /kickall. Ask the owner.' : 'This command is owner-only.'), { parse_mode: 'HTML' });
function audit(ctx, text) { // tell the owner what premium users are doing (AUDIT_PREMIUM=false to disable)
  if (!AUDIT || access.isOwner(ctx.from.id)) return;
  const u = ctx.from;
  notify(panel('PREMIUM ACTIVITY', `<b>${escapeHtml([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'User')}</b> <code>${u.id}</code>\n${text}`), { parse_mode: 'HTML' });
}
bot.command('kickall', (ctx) => (access.canUse(ctx.from.id, 'kickall') ? beginScan(ctx) : deny(ctx, 'kickall')));
bot.command('listgroups', showGroupIndex);

// Group modules: /closetime, /opentime, /approve, /demote, /ban, /antilink, /antimention,
// /antigroupmention, /antibot, /antisticker, /antimedia, /antiviewonce, /antihijack (plus their short aliases). They follow the /kickall
// flow: send the command, pick an admin group, the action runs. /ban is global (no group).
async function runJob(ctx, job, g) {
  const T = sess(ctx);
  const mod = modules.registry[job.cmd];
  const chatId = ctx.chat.id;
  const out = modules.makeOut(chatId, T.pickerMessageId);
  clearPicker(T);
  if (!access.canUse(ctx.from.id, job.cmd) || !access.inScope(ctx.from.id, g.id)) return out.set(panel('NOT ALLOWED', 'You no longer have access to that command or group.'), { parse_mode: 'HTML' });
  if (!S.connected) return out.set(panel('LINK LOST', 'WhatsApp is not connected. Reconnect before running a module.'), { parse_mode: 'HTML' });
  audit(ctx, `${escapeHtml(jobLabel(job))} → ${escapeHtml(g.name)}`);
  await out.set(panel('MODULE ENGAGED', `<b>Target:</b> ${escapeHtml(g.name)}\n<code>${escapeHtml(jobLabel(job))}</code>`), { parse_mode: 'HTML' });
  try { await mod.run({ g, args: job.args, out, chatId, ctx }); }
  catch (e) { await out.set(panel('MODULE FAILED', escapeHtml(e.message)), { parse_mode: 'HTML' }); }
}
for (const [name, mod] of Object.entries(modules.registry)) {
  bot.command([name, ...mod.aliases], async (ctx) => {
    if (!access.canUse(ctx.from.id, name)) return deny(ctx, name);
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const prep = mod.prepare(args);
    if (prep.usage) return ctx.reply(prep.usage, { parse_mode: 'HTML' });
    const job = { cmd: name, args: prep.args };
    if (mod.global) return mod.run({ args: job.args, out: modules.makeOut(ctx.chat.id), chatId: ctx.chat.id, ctx });
    return beginScan(ctx, job);
  });
}
bot.action('ui_scan', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); return access.canUse(ctx.from.id, 'kickall') ? beginScan(ctx) : deny(ctx, 'kickall'); });
bot.action('ui_status', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); return showStatus(ctx); });
bot.action('ui_groups', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); return showGroupIndex(ctx); });
bot.action('ui_help', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); return ctx.reply(helpText(ctx), { parse_mode: 'HTML', ...homeKeyboard(ctx) }); });
bot.action(/^group_page:(\d+)$/, async (ctx) => {
  const T = sess(ctx);
  await ctx.answerCbQuery().catch(() => {});
  const page = Number(ctx.match[1]);
  if (T.stage !== 'pick' || page < 0 || page >= pageCount(T)) return ctx.reply(panel('SELECTION EXPIRED', 'Start a fresh scan with /kickall.'), { parse_mode: 'HTML' });
  return showPicker(ctx, page, true);
});
bot.action(/^group_select:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return chooseGroup(ctx, Number(ctx.match[1]));
});
bot.action('kick_yes', async (ctx) => {
  const T = sess(ctx);
  await ctx.answerCbQuery('Operation authorized').catch(() => {});
  if (T.stage !== 'confirm' || !T.chosen) return ctx.reply(panel('SELECTION EXPIRED', 'Start a fresh scan with /kickall.'), { parse_mode: 'HTML' });
  if (!access.canUse(ctx.from.id, 'kickall') || !access.inScope(ctx.from.id, T.chosen.id)) return deny(ctx, 'kickall');
  return runKick(ctx);
});
bot.action('kick_no', async (ctx) => {
  const T = sess(ctx);
  await ctx.answerCbQuery('Selection cancelled').catch(() => {});
  T.stage = null; T.chosen = null; T.job = null; clearPicker(T);
  return ctx.editMessageText(panel('SELECTION ABORTED', 'No members were removed. Open /start to return to the control panel.'), { parse_mode: 'HTML', ...homeKeyboard(ctx) }).catch(() => {});
});

bot.on('text', async (ctx) => {
  const T = sess(ctx);
  const txt = ctx.message.text.trim();

  if (T.stage === 'number') {
    const number = txt.replace(/\D/g, '');
    if (number.length < 7 || number.length > 15) return ctx.reply(panel('INVALID NUMBER', 'Enter 7–15 digits, including your country code. Do not include +, spaces, or punctuation.'), { parse_mode: 'HTML' });
    T.stage = null;
    await ctx.reply(panel('REQUESTING PAIRING CODE', 'Contacting WhatsApp…'), { parse_mode: 'HTML' });
    try {
      const code = await requestPair(number);
      return ctx.reply(
        panel('PAIRING CODE READY', `<code>${escapeHtml(code)}</code>\n\nOn your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, then enter this code.`),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📋  COPY PAIRING CODE', copy_text: { text: code } }]] } }
      );
    } catch (e) {
      return ctx.reply(panel('PAIRING FAILED', `${escapeHtml(e.message)}\n\nSend /kickall to try again.`), { parse_mode: 'HTML' });
    }
  }

  if (T.stage === 'pick') {
    const n = /^\d+$/.test(txt) ? parseInt(txt, 10) : 0;
    if (n < 1 || n > T.groups.length) return ctx.reply(panel('TARGET NOT RECOGNIZED', `Send a number from 1 to ${T.groups.length}, or tap a group button.`), { parse_mode: 'HTML' });
    return chooseGroup(ctx, n - 1);
  }
});

async function runKick(ctx) {
  const T = sess(ctx);
  const g = T.chosen;
  if (!g) return ctx.reply(panel('NO TARGET', 'Select a group before starting an operation.'), { parse_mode: 'HTML' });
  T.stage = null;
  T.chosen = null;
  if (!S.connected) {
    clearPicker(T);
    return ctx.reply(panel('LINK LOST', 'WhatsApp is not connected. Reconnect before starting an operation.'), { parse_mode: 'HTML' });
  }
  if (S.kickRunning) return ctx.reply(panel('BUSY', 'A removal sequence is already running.'), { parse_mode: 'HTML' });

  S.kickRunning = true;
  audit(ctx, `/KICKALL → ${escapeHtml(g.name)}`);
  const chatId = ctx.chat.id;
  let status = null;
  if (T.pickerChatId != null && T.pickerMessageId != null) {
    status = await updateMessage(T.pickerChatId, T.pickerMessageId, operationText(g, 0, 0, 0, 0, 'OPERATION STARTING'));
  }
  if (!status) status = await ctx.reply(operationText(g, 0, 0, 0, 0, 'OPERATION STARTING'), { parse_mode: 'HTML' });
  clearPicker(T);
  let removed = 0, failed = 0, total = 0;
  try {
    // Fetch the member list right now so it is never stale
    const meta = await S.sock.groupMetadata(g.id);
    const ids = myIds();
    const targets = meta.participants
      .filter((p) => !isMe(p, ids))
      .filter((p) => p.admin !== 'superadmin') // group creator can't be removed
      .filter((p) => KICK_ADMINS || !isAdminP(p))
      .map((p) => p.id);
    total = targets.length;
    if (!total) {
      const text = panel('NO ELIGIBLE MEMBERS', `No members were eligible for removal in <b>${escapeHtml(g.name)}</b>.`);
      if (!await updateMessage(chatId, status.message_id, text)) await ctx.reply(text, { parse_mode: 'HTML' });
      return;
    }

    await updateMessage(chatId, status.message_id, operationText(g, 0, total, removed, failed));
    for (let i = 0; i < total; i += 5) {
      const batch = targets.slice(i, i + 5);
      try {
        const res = await S.sock.groupParticipantsUpdate(g.id, batch, 'remove');
        const ok = Array.isArray(res) ? res.filter((r) => String(r.status) === '200').length : batch.length;
        removed += ok; failed += batch.length - ok;
      } catch { failed += batch.length; }
      const processed = Math.min(i + batch.length, total);
      if ((i / 5) % 3 === 2 || processed === total) {
        await updateMessage(chatId, status.message_id, operationText(g, processed, total, removed, failed));
      }
      await sleep(2000 + Math.random() * 1500); // go slow to reduce ban risk
    }
    const finalText = panel('OPERATION COMPLETE', `<b>Target:</b> ${escapeHtml(g.name)}\n<code>[${progressBar(total, total)}] 100%</code>\n\nRemoved: <b>${removed}</b>\nFailed: <b>${failed}</b> of ${total}\n\n<i>Return to the command deck with /start.</i>`);
    if (!await updateMessage(chatId, status.message_id, finalText)) await ctx.reply(finalText, { parse_mode: 'HTML' });
  } catch (e) {
    const finalText = panel('OPERATION HALTED', `${escapeHtml(e.message)}\n\nRemoved before error: <b>${removed}</b>`);
    if (!await updateMessage(chatId, status.message_id, finalText)) await ctx.reply(finalText, { parse_mode: 'HTML' });
  } finally {
    S.kickRunning = false;
  }
}

bot.catch((e) => console.error('Telegram error:', e.message));

/* ---------------- Boot ---------------- */
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e?.message || e));
// Everyone with access sees the premium commands; the owner's chat also lists the owner-only ones.
const MENU_BASE = [
  { command: 'start', description: 'Open the NOVA control panel' },
  { command: 'listgroups', description: 'Inspect your groups' },
  { command: 'status', description: 'Check WhatsApp link status' },
  { command: 'me', description: 'See your access and plan' },
  { command: 'publicaccess', description: 'Owner: toggle public Telegram access' },
  { command: 'closetime', description: 'Close a group after a countdown' },
  { command: 'opentime', description: 'Open a group after a countdown' },
  { command: 'approve', description: 'Approve pending join requests' },
  { command: 'demote', description: 'Demote an admin by number' },
  { command: 'antilink', description: 'Anti-link protection' },
  { command: 'antimention', description: 'Anti mass-mention protection' },
  { command: 'antigroupmention', description: 'Block @everyone / group mentions' },
  { command: 'antibot', description: 'Detect and remove other bots' },
  { command: 'antisticker', description: 'Delete, warn or remove sticker senders' },
  { command: 'antimedia', description: 'Delete, warn or remove media senders' },
  { command: 'antiviewonce', description: 'Moderate view-once messages in groups' },
  { command: 'antihijack', description: 'Reverse unauthorized promote/demote' },
  { command: 'help', description: 'Show the operator guide' },
];
const MENU_OWNER = [
  ...MENU_BASE.slice(0, 1),
  { command: 'kickall', description: 'Scan admin groups and select a target' },
  ...MENU_BASE.slice(1, -1),
  { command: 'ban', description: 'Manage the WhatsApp ban list' },
  { command: 'grant', description: 'Give someone premium access' },
  { command: 'revoke', description: 'Remove premium access' },
  { command: 'users', description: 'List premium and blocked users' },
  { command: 'scope', description: 'Choose groups a premium user can manage' },
  { command: 'block', description: 'Block a Telegram user' },
  { command: 'unblock', description: 'Unblock a Telegram user' },
  ...MENU_BASE.slice(-1),
];
bot.telegram.setMyCommands(MENU_BASE).catch(() => {});
bot.telegram.setMyCommands(MENU_OWNER, { scope: { type: 'chat', chat_id: OWNER_ID } }).catch(() => {});
console.log('\n╭────────────────────────────────────────╮');
console.log('│  EXO FLOODS // WHATSAPP GROUP OPS       │');
console.log('│  CONTROL NODE INITIALIZING              │');
console.log('╰────────────────────────────────────────╯\n');
loadBaileys()
  .then(startWA)
  .catch((e) => { console.error('Failed to start WhatsApp:', e); process.exit(1); });

async function startTelegram() {
  for (let attempt = 1; ; attempt++) {
    try {
      const me = await bot.telegram.getMe(); // verifies the token and network access to api.telegram.org
      console.log(`Telegram token OK: @${me.username}`);
      await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
      // launch() only resolves when polling stops, so use the onLaunch callback
      bot.launch({ dropPendingUpdates: false }, () => {
        console.log('NOVA control node online (Telegram polling)');
        notify(panel('CONTROL NODE ONLINE', 'Send /start to open the NOVA command deck.'), { parse_mode: 'HTML' });
      }).catch((e) => {
        console.error('Telegram polling stopped:', e.message);
        if (/409/.test(e.message)) console.error('Another instance is using this bot token (Railway/other host?). Stop it, then restart this one.');
        setTimeout(startTelegram, 5000);
      });
      return;
    } catch (e) {
      console.error(`Telegram connect failed (attempt ${attempt}): ${e.message}`);
      if (/401|Unauthorized/i.test(e.message)) { console.error('TELEGRAM_BOT_TOKEN is invalid. Get a fresh one from @BotFather.'); process.exit(1); }
      await sleep(Math.min(30000, attempt * 3000));
    }
  }
}
startTelegram();
process.once('SIGINT', () => { bot.stop(); process.exit(0); });
process.once('SIGTERM', () => { bot.stop(); process.exit(0); });
