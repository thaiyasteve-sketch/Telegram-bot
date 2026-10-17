# EXO FLOODS // WhatsApp Group Ops

A polished sci-fi Telegram command deck for the WhatsApp group-management bot. The interface runs entirely in Telegram; no separate dashboard or additional dependency is required.

## Control panel

Use `/start` to open the NOVA command deck. It offers buttons for:

- **Scan admin groups** — shows eligible groups in a paged selector with tap-to-select buttons. You can also reply with the displayed group number.
- **System status** — shows Telegram/WhatsApp connection state and the configured admin/confirmation policy.
- **Group index** — lists the groups, member counts, admin access, and IDs.
- **Operator guide** — shows the command sequence and safety notes.

Core commands: `/start`, `/kickall`, `/listgroups`, `/status`, and `/help`.

## Group modules

These work like `/kickall`: send the command, pick an admin group from the selector (or reply with its number), and the action runs. Arguments are checked first, so a typo never wastes a group pick. The linked WhatsApp account must be an admin of the group.

| Command | What it does |
| --- | --- |
| `/closetime 30s\|7m\|3h\|2d` | Close the group (admins only) after a live countdown. Cancel button included. Max 30 days. |
| `/opentime 30s\|7m\|3h\|2d` | Open the group after a countdown. |
| `/approve` · `/approve all` · `/approve 25` | Show the pending join-request count, approve all, or approve the first N. |
| `/demote 2348012345678` | Demote an admin by phone number (the creator and the linked account are protected). |
| `/ban 2348012345678` · `/ban list` · `/ban remove <number>` | Global ban list (no group pick). Banned numbers are removed whenever they join a group where the linked account is admin. |
| `/antilink on\|strict\|off\|status\|delete\|kick\|mute` | Delete links, warn, then mute/kick after 3 warnings. `strict` kicks on the first link. |
| `/antimention on\|strict\|off\|status` | Delete and warn at 5+ mentions; `strict` kicks at 3+. |
| `/antisticker on\|off\|delete\|warn\|kick\|status` | Detect WhatsApp stickers. `on` defaults to delete-only; `warn` deletes and warns; `kick` deletes and removes the sender. |
| `/antimedia on\|off\|delete\|warn\|kick\|status` | Detect images, video, audio, documents and stickers. `on` defaults to delete-only; `warn` deletes and warns; `kick` deletes and removes the sender. Anti-sticker takes priority if both are enabled. |
| `/antiviewonce on\|off\|delete\|warn\|kick\|status` | Detect and moderate view-once messages in groups. `on` defaults to delete-only; `warn` deletes and warns; `kick` deletes and removes the sender. This does not reveal or forward view-once media to private chats. |
| `/antigroupmention on\|off\|set delete\|kick\|status\|reset` | Block @everyone, group mentions and mass tagging. |
| `/antibot on\|kick\|warn\|scan\|off\|status` | Detect bots (multi-device accounts, bot commands, menu signatures). `on` warns then kicks, `kick` kicks at once, `warn` only warns. |
| `/antihijack on\|off\|status` | Reverse promotes/demotes made by anyone except the linked account or the group creator, and demote the offender. |

Short aliases from the original bot also work: `/ct`, `/ot`, `/agm`, `/nolink`, `/antitag`, `/nobot`, `/nosticker`, `/antistickers`, `/nomedia`, `/antimedias`, `/adminguard`, `/removeadmin`, `/banuser`, and so on.

Notes:

- Settings, the ban list and pending timers are saved in `settings.json` at the project root. Open/close timers survive restarts; one that came due while the bot was offline runs as soon as WhatsApp reconnects.
- Protections are enforced by the bot while it is running. Group admins and the linked account are always exempt.
- WhatsApp cannot mute a single member, so **mute** means the bot deletes every message from that member for 24 hours.
- Warnings expire after the cooldown (24 hours by default).


For each selected group, the default flow presents a clear confirmation screen before removal and then updates a live progress panel. A cancelled selection removes nobody. The linked account and group creator are protected; the admin behavior is controlled by `KICK_ADMINS`.

> WhatsApp's unofficial protocol can result in an account being flagged or banned, and mass removals cannot be automatically undone. Use only in groups you own or administer.

## Access control

The bot is private by default. Anyone not approved sees an access-restricted screen with their Telegram ID and a **Request access** button.

| Role | Can do |
| --- | --- |
| **Owner** (`TELEGRAM_OWNER_ID`) | Everything: pairing WhatsApp, `/kickall`, `/ban`, all group modules on every group, and access management. |
| **Premium** | The group modules (`/closetime`, `/opentime`, `/approve`, `/demote`, `/antilink`, `/antimention`, `/antigroupmention`, `/antibot`, `/antisticker`, `/antimedia`, `/antiviewonce`, `/antihijack`), `/listgroups`, `/status`, `/me`. Only on the groups the owner assigns. |
| **Blocked** | Ignored silently. |

Owner commands:

| Command | What it does |
| --- | --- |
| `/grant 123456789` | Premium for 30 days. Add a duration (`12h`, `7d`, `4w`, `forever`) and/or `kickall` to also allow `/kickall`. Running it again on an existing user changes their plan. |
| `/revoke 123456789` | Remove premium. The user is told. |
| `/users` | List premium users (plan, expiry, groups) and blocked IDs. |
| `/scope 123456789` | Tick which groups that user can manage, or choose **All groups** (which also covers groups added later). Also offered right after a grant. |
| `/block 123456789` · `/unblock 123456789` | Revoke and silently ignore a Telegram user. (For WhatsApp numbers use `/ban`.) |

Request flow: a stranger taps **Request access**, you get a notification with **7 days / 30 days / Forever / Deny / Block** buttons, and the user is messaged with your decision. Requests are limited to one per 10 minutes per user. Find a user's ID with [@userinfobot](https://t.me/userinfobot); they must open the bot and press Start once so it can message them.

Notes:

- New premium users get **all groups** until you narrow them with `/scope`. Premium users never see `/kickall`, `/ban` or access commands unless you grant `kickall`.
- Expired plans lock the user out automatically and tell them why. They can request access again.
- Access, plans and scopes are stored in `settings.json`.
- Each user has their own picker, so several people can use the bot at the same time. Open/close timers can be cancelled only by the owner or whoever started them.
- Telegram menus adapt: premium users see only their commands, the owner's chat shows everything.

## Settings (environment variables or `.env`)

- `TELEGRAM_BOT_TOKEN` (required) — create a bot with [@BotFather](https://t.me/BotFather).
- `TELEGRAM_OWNER_ID` (required) — your numeric Telegram ID from [@userinfobot](https://t.me/userinfobot). This user is the **owner** with full control. Everyone else needs access from the owner (see Access control).
- `KICK_ADMINS` (default `true`) — `false` skips admins; the group creator remains protected.
- `AUDIT_PREMIUM` (default `true`) — message the owner whenever a premium user runs a command. Set `false` to silence it.
- `REQUIRE_CONFIRM` (default `true`) — `false` skips the final confirmation step. Keeping this enabled is recommended.

## Pterodactyl

1. Import `egg-whatsapp-kickall-bot.json` (Nests > Import Egg) and create a server with it (Node 20 or 22, 512 MB+).
2. Fill in the Startup tab variables.
3. Upload the ZIP in Files and unarchive it. Make sure `index.js` and `package.json` are in `/home/container`.
4. Start the server. The console shows the EXO FLOODS boot banner and the control-node online message after Telegram polling starts.
5. Open the bot in Telegram and send `/start`.

## Local

`npm install && npm start` (Node 20+).

The WhatsApp login is stored in `.whatsapp-auth`; do not delete it unless you want to link again.
