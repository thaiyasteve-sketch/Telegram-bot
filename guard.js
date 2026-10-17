'use strict';
// Enforcement layer. The Telegram commands only flip settings; this file is what
// actually reacts to WhatsApp events (messages, joins, promotions/demotions).
const store = require('./store');

const MUTE_MS = 24 * 60 * 60 * 1000; // "mute" = bot deletes every message from the member for 24h
const WARN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/* ---------------- text helpers ---------------- */
const TLDS = 'com|net|org|io|me|co|xyz|info|biz|link|click|top|site|online|app|dev|tv|cc|ly|gg|gl|ws|us|uk|ru|cn|tk|ml|ga|cf|gq|pw|club|shop|store|live|vip|fun|icu|cyou|world|today|ai|ng|tech|cloud|page|space|work|email|win|bid|stream|download|loan';
const URL_RE = /\b(?:https?|ftp):\/\/\S+/i;
const WWW_RE = /\bwww\.[a-z0-9-]+/i;
const INVITE_RE = /\b(?:chat\.whatsapp\.com|whatsapp\.com\/channel|wa\.me|t\.me|telegram\.(?:me|dog)|discord\.gg|discord(?:app)?\.com\/invite)\b/i;
const DOMAIN_RE = new RegExp(`(?<![@\\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})(?![a-z0-9@-])`, 'i');

function normalizeText(t) {
  return String(t || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u2060\uFEFF\u202A-\u202E]/g, '')   // invisible characters
    .replace(/[。｡]/g, '.')
    .replace(/[\[({]\s*(?:\.|dot)\s*[\])}]/gi, '.')            // example[.]com, example(dot)com
    .replace(/hxxp(s?)/gi, 'http$1')                           // hxxps://
    .replace(/\bh\s+t\s+t\s+p\s*(s?)\s*:\s*\/\s*\/\s*/gi, 'http$1://'); // h t t p s : / /
}
function hasLink(text) {
  const t = normalizeText(text);
  return URL_RE.test(t) || WWW_RE.test(t) || INVITE_RE.test(t) || DOMAIN_RE.test(t);
}

// Well-known bot command words. Matching any ".word" would flag people typing "#love",
// so the prefix check only fires on real bot commands. Extend as needed.
const BOT_WORDS = 'menu|help|ping|alive|runtime|uptime|owner|speed|play|song|video|ytmp3|ytmp4|tiktok|igdl|fbdl|sticker|s|toimg|ai|gpt|chatgpt|imagine|tagall|hidetag|kick|add|promote|demote|mute|unmute|antilink|antibot|welcome|info|botinfo|script|repo|sc|tts|translate|quote|joke|meme|weather|lyrics|download|setpp|getpp|rank|level|daily|balance|bal|slot|roll';
const BOT_CMD_RE = new RegExp(`^[.!/#$?](?:${BOT_WORDS})(?:\\s|$)`, 'i');
const BOT_SIGS = [
  /(?:^|\n)\s*[╔╭┏┌][═─━]{3,}/,                         // box-drawing menu frames
  /\b(?:powered|created|made)\s+by\b.*\b(?:bot|md|wabot)\b/i,
  /\b(?:bot\s+(?:menu|commands?|status|info)|command\s+list)\b/i,
  /\btype\s+[.!/#]?(?:menu|help)\b/i,
  /\bprefix\s*[:：]\s*[.!/#$?]/i,
];
const isBotText = (text) => BOT_CMD_RE.test(text.trim()) || BOT_SIGS.some((re) => re.test(text));
const isMdBotJid = (jid) => {
  const m = String(jid).match(/^(\d+):(\d+)@(?:s\.whatsapp\.net|lid)$/);
  return !!m && parseInt(m[2], 10) > 0;
};

/* ---------------- message helpers ---------------- */
function unwrap(m) {
  let cur = m;
  for (let i = 0; i < 6 && cur; i++) {
    const inner = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message || cur.viewOnceMessageV2?.message
      || cur.viewOnceMessageV2Extension?.message || cur.documentWithCaptionMessage?.message
      || cur.editedMessage?.message || cur.protocolMessage?.editedMessage;
    if (!inner) break;
    cur = inner;
  }
  return cur || {};
}
const textOf = (m) => m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption
  || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title || '';
const ctxOf = (m) => Object.values(m).map((v) => v && typeof v === 'object' ? v.contextInfo : null).find(Boolean) || null;

module.exports = function createGuard(core) {
  const { S, myIds, isMe, isAdminP, userPart, notify, escapeHtml } = core;

  /* ---------------- participant helpers ---------------- */
  const pIds = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(userPart);
  const findParticipant = (meta, jids) => {
    const want = new Set(jids.filter(Boolean).map(userPart));
    return meta.participants.find((p) => pIds(p).some((x) => want.has(x)));
  };
  const toParticipant = (p) => (typeof p === 'string' ? { id: p } : p);

  const cache = new Map();
  async function getMeta(sock, jid, force = false) {
    const hit = cache.get(jid);
    if (!force && hit && Date.now() - hit.at < 60000) return hit.meta;
    const meta = await sock.groupMetadata(jid);
    cache.set(jid, { meta, at: Date.now() });
    return meta;
  }
  function botIsAdmin(meta) {
    const ids = myIds();
    const me = meta.participants.find((p) => isMe(p, ids));
    const owner = [meta.owner, meta.ownerPn].filter(Boolean).some((j) => ids.has(userPart(j)));
    return !!((me && isAdminP(me)) || owner);
  }

  /* ---------------- actions ---------------- */
  const lastSaid = new Map();
  async function say(a, text) {
    const key = `${a.jid}:${a.num}`;
    if (Date.now() - (lastSaid.get(key) || 0) < 8000) return; // don't flood on spam bursts
    lastSaid.set(key, Date.now());
    await a.sock.sendMessage(a.jid, { text: `╭─━━━〔 EXO FLOODS 〕━━━╮\n${text}\n╰─━━━━━━━━━━━━━━━━━━━━─╯\n◈ GROUP PROTECTION SYSTEM ◈`, mentions: [a.target] }).catch(() => {});
  }
  const del = (a) => a.sock.sendMessage(a.jid, { delete: a.delKey || a.key }).catch(() => {});
  async function kick(a, feature) {
    try {
      await a.sock.groupParticipantsUpdate(a.jid, [a.target], 'remove');
      // Kick mode is intentionally silent: no Telegram notification.
      return true;
    } catch (e) {
      console.error(`[guard] kick failed (${feature}):`, e.message);
      return false;
    }
  }
  const tag = (a) => `@${a.num}`;

  /* ---------------- message rules ---------------- */
  async function antiGroupMention(a, text, ctx) {
    const n = (ctx?.mentionedJid || []).length;
    let why = null;
    if (ctx?.groupMentions?.length) why = 'group mention';
    else if (Number(ctx?.nonJidMentions) > 0 || /(^|\s)@(?:everyone|all|group)\b/i.test(text)) why = '@everyone';
    else if (n >= Math.max(5, Math.ceil(a.meta.participants.length * 0.8))) why = 'mass tag';
    if (!why) return false;
    await del(a);
    store.bump(a.jid, 'antigroupmention');
    if (a.g.antigroupmentionAction === 'kick') {
      await kick(a, 'antigroupmention');
    } else {
      await say(a, `🗑️ ${tag(a)} group-wide mentions are not allowed here.`);
    }
    return true;
  }

  async function antiMention(a, text, ctx) {
    const max = a.g.antimentionMax || 5;
    if ((ctx?.mentionedJid || []).length < max) return false;
    await del(a);
    store.bump(a.jid, 'antimention');
    if (a.g.antimentionMode === 'strict' || a.g.antimentionAction === 'kick') {
      await kick(a, 'antimention');
    } else {
      const w = store.addWarn(a.jid, 'antimention', a.num, WARN_COOLDOWN_MS);
      await say(a, `⚠️ 𝐖𝐀𝐑𝐍𝐈𝐍𝐆 ⚠️\n${tag(a)} mass mentions are not allowed.\n◇ Warning ${w} ◇`);
    }
    return true;
  }

  async function antiLink(a, text) {
    if (!hasLink(text)) return false;
    await del(a);
    store.bump(a.jid, 'antilink');
    const g = a.g;
    if (g.antilinkMode === 'strict') {
      await kick(a, 'antilink');
      return true;
    }
    const max = g.antilinkMaxWarnings || 3;
    const n = store.addWarn(a.jid, 'antilink', a.num, (g.antilinkCooldown || 24) * 3600000);
    if (n < max) {
      await say(a, `⚠️ 𝐖𝐀𝐑𝐍𝐈𝐍𝐆 ⚠️\n${tag(a)} links are not allowed here.\n◇ Warning ${n}/${max} ◇`);
      return true;
    }
    const action = g.antilinkAction || 'mute';
    if (action === 'kick') {
      store.clearWarn(a.jid, 'antilink', a.num);
      await kick(a, 'antilink');
    } else if (action === 'mute') {
      store.clearWarn(a.jid, 'antilink', a.num);
      store.mute(a.jid, a.num, Date.now() + MUTE_MS);
      // Silent enforcement: no group or Telegram notification in mute/delete mode.
    } else {
      await say(a, `⚠️ 𝐖𝐀𝐑𝐍𝐈𝐍𝐆 ⚠️\n${tag(a)} links are not allowed here.\n◇ Warning ${n}/${max} ◇`);
    }
    return true;
  }

  // Warn on the first detection, remove on the second ("on"), remove at once ("kick") or only warn ("warn").
  async function botStrike(a, reason) {
    const mode = a.g.antibotMode || 'kick';
    store.bump(a.jid, 'antibot');
    if (mode === 'instant') {
      await kick(a, 'antibot');
      return;
    }
    if (mode === 'warn') {
      await say(a, `⚠️ 𝐀𝐍𝐓𝐈-𝐁𝐎𝐓 𝐖𝐀𝐑𝐍𝐈𝐍𝐆 ⚠️\n${tag(a)} looks like a bot (${reason}).\n◇ Warning only ◇`);
      return;
    }
    const n = store.addWarn(a.jid, 'antibot', a.num, WARN_COOLDOWN_MS);
    if (n < 2) {
      // Silent until a warning-mode action is explicitly selected.
    } else {
      store.clearWarn(a.jid, 'antibot', a.num);
      await kick(a, 'antibot');
    }
  }

  // Content-type checks operate on the unwrapped Baileys message payload.
  const hasSticker = (content) => !!content?.stickerMessage;
  // Detect the wrapper before unwrap() exposes the payload. This moderation
  // rule removes view-once messages; it intentionally does not extract or relay them.
  function hasViewOnce(message) {
    let cur = message;
    for (let i = 0; i < 8 && cur; i++) {
      if (cur.viewOnceMessage || cur.viewOnceMessageV2 || cur.viewOnceMessageV2Extension) return true;
      const next = cur.ephemeralMessage?.message || cur.documentWithCaptionMessage?.message || cur.editedMessage?.message || cur.protocolMessage?.editedMessage;
      if (!next) break;
      cur = next;
    }
    return false;
  }
  const hasMedia = (content) => !!(
    content?.imageMessage || content?.videoMessage || content?.audioMessage ||
    content?.documentMessage || content?.documentWithCaptionMessage ||
    content?.stickerMessage || content?.ptvMessage
  );

  async function enforceContentRule(a, feature, action, label) {
    await del(a);
    store.bump(a.jid, feature);
    if (action === 'kick') {
      await kick(a, feature); // kick mode performs the action silently
      return;
    }
    if (action === 'warn') {
      const n = store.addWarn(a.jid, feature, a.num, WARN_COOLDOWN_MS);
      await say(a, `⚠️ 𝐆𝐑𝐎𝐔𝐏 𝐖𝐀𝐑𝐍𝐈𝐍𝐆 ⚠️\n${tag(a)}: ${label} are not allowed here.\n◇ Warning ${n} ◇`);
      return;
    }
    // Delete mode is silent: no warning and no bot-generated group/Telegram notice.
  }

  async function handleMessage(sock, m) {
    const jid = m.key?.remoteJid;
    if (!jid || !jid.endsWith('@g.us') || m.key.fromMe || !m.message) return;
    const g = store.peekGroup(jid);
    if (!g || !(g.antilink || g.antimention || g.antigroupmention || g.antibot || g.antisticker || g.antimedia || g.antiviewonce || g.muted)) return;

    const outer = unwrap(m.message);
    const edited = outer.protocolMessage?.editedMessage ? unwrap(outer.protocolMessage.editedMessage) : null;
    if (outer.protocolMessage && !edited) return; // revokes, ephemeral settings, etc.
    const content = edited || outer;
    const sender = m.key.participant || m.participant;
    if (!sender) return;

    const meta = await getMeta(sock, jid).catch(() => null);
    if (!meta || !botIsAdmin(meta)) return; // cannot enforce without admin rights
    const sp = findParticipant(meta, [sender, m.key.participantAlt, m.key.participantPn]);
    if (sp && (isAdminP(sp) || isMe(sp, myIds()))) return; // admins and the linked account are exempt

    const target = sp?.id || sender;
    const a = {
      sock, jid, meta, g, target, num: userPart(target), name: meta.subject,
      key: m.key, delKey: edited && outer.protocolMessage.key ? { ...outer.protocolMessage.key, participant: m.key.participant } : m.key,
    };

    if (store.isMuted(jid, a.num)) { await del(a); return; }

    // View-once policy is evaluated on the original wrapper before unwrapping.
    if (g.antiviewonce && hasViewOnce(m.message)) {
      await enforceContentRule(a, 'antiviewonce', g.antiviewonceAction || 'delete', 'view-once messages');
      return;
    }

    // Sticker rule takes priority so a sticker is not reported twice by antimedia.
    if (g.antisticker && hasSticker(content)) {
      await enforceContentRule(a, 'antisticker', g.antistickerAction || 'delete', 'stickers');
      return;
    }
    if (g.antimedia && hasMedia(content)) {
      await enforceContentRule(a, 'antimedia', g.antimediaAction || 'delete', 'media');
      return;
    }

    const text = textOf(content);
    const ctx = ctxOf(content);
    if (g.antigroupmention && await antiGroupMention(a, text, ctx)) return;
    if (g.antimention && await antiMention(a, text, ctx)) return;
    if (g.antilink && text && await antiLink(a, text)) return;
    if (g.antibot && text && isBotText(text)) await botStrike(a, 'bot signature');
  }

  /* ---------------- participant events ---------------- */
  async function onJoin(sock, jid, list) {
    const g = store.peekGroup(jid);
    if (!store.bannedList().length && !g?.antibot) return;
    const meta = await getMeta(sock, jid, true).catch(() => null);
    if (!meta || !botIsAdmin(meta)) return;
    for (const p of list) {
      const target = p.id;
      const a = { sock, jid, meta, g: g || {}, target, num: userPart(target), name: meta.subject };
      if ([...pIds(p)].some((x) => store.isBanned(x))) {
        await kick(a, 'ban list');
        continue;
      }
      if (g?.antibot && isMdBotJid(target)) await botStrike(a, 'multi-device bot account');
    }
  }

  async function onRoleChange(sock, jid, list, ev) {
    const authorIds = [ev.author, ev.authorPn, ev.authorLid].filter(Boolean);
    if (!authorIds.length) return;
    if (authorIds.some((x) => myIds().has(userPart(x)))) return; // our own actions are authorized (also prevents loops)
    const meta = await getMeta(sock, jid, true).catch(() => null);
    if (!meta || !botIsAdmin(meta)) return;
    const authorP = findParticipant(meta, authorIds);
    if (authorP?.admin === 'superadmin') return; // the group creator is authorized

    const revert = ev.action === 'promote' ? 'demote' : 'promote';
    const ids = myIds();
    const targets = list.filter((p) => !isMe(p, ids)).map((p) => p.id);
    const retry = async (fn) => {
      for (let i = 0; i < 3; i++) {
        try { return await fn(); } catch (e) { if (i === 2) console.error('[guard] antihijack failed:', e.message); await new Promise((r) => setTimeout(r, 400)); }
      }
      return null;
    };
    if (targets.length) await retry(() => sock.groupParticipantsUpdate(jid, targets, revert));
    if (authorP && authorP.admin === 'admin') await retry(() => sock.groupParticipantsUpdate(jid, [authorP.id], 'demote'));
    cache.delete(jid);
    notify(`<b>◢ GUARD // ANTIHIJACK</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\nReversed an unauthorized <b>${escapeHtml(ev.action)}</b> in <b>${escapeHtml(meta.subject || jid)}</b>${authorP ? ` and demoted <code>+${escapeHtml(userPart(authorP.id))}</code>` : ''}.`, { parse_mode: 'HTML' });
  }

  async function handleParticipants(sock, ev) {
    const { id: jid, action } = ev;
    cache.delete(jid);
    const list = (ev.participants || []).map(toParticipant);
    if (action === 'add') return onJoin(sock, jid, list);
    if ((action === 'promote' || action === 'demote') && store.peekGroup(jid)?.antihijack) return onRoleChange(sock, jid, list, ev);
  }

  function attach(sock) {
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) handleMessage(sock, m).catch((e) => console.error('[guard] message:', e.message));
    });
    sock.ev.on('group-participants.update', (ev) => {
      handleParticipants(sock, ev).catch((e) => console.error('[guard] participants:', e.message));
    });
  }

  return { attach, hasLink, isBotText, isMdBotJid, findParticipant, pIds, getMeta, botIsAdmin };
};
