# Automation Network – WhatsApp bot

A WhatsApp bot for a private community of automation professionals.

- **Joining:** a person messages the bot "Hi", answers a few questions, and only then gets into the group.
- **The group is content only:** one post a day (insights, news, what's happening in the automation market). Member details are never posted there.
- **Connect:** jobs and backfills, referrals, and expert help happen in private chat with the bot. Two members see each other's name and number only after **both** say yes.

It runs on [Baileys](https://github.com/WhiskeySockets/Baileys) (free, unofficial) with a spare WhatsApp number. Data is stored in one SQLite file.

> **Risk to know about:** Baileys is not an official WhatsApp product. WhatsApp can ban numbers that use it. Use a spare SIM, never your personal number. The bot keeps the risk low: it only replies to people who message it first (except connect requests to members), waits 1–3 seconds before each reply, and limits how many requests anyone receives.

## What you need

- Node.js 22.13 or newer
- A spare SIM with WhatsApp installed on a phone (the "bot number")
- A WhatsApp group where the bot number is an **admin**

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

1. Open `.env` and put your own number in `ADMIN_NUMBERS` (country code + number, digits only, e.g. `919876543210`).
2. Start the bot:

   ```bash
   npm start
   ```

3. A QR code appears. On the bot's phone: **WhatsApp → Linked devices → Link a device** and scan it.
   (No camera? Put the bot's number in `PAIRING_NUMBER` and you get an 8-character code to type instead.)
4. In WhatsApp, add the bot number to your group and make it an **admin**.
5. In the group settings, turn on **Approve new participants**.
6. From your admin number, send the bot `!groups`. Copy your group's ID into `GROUP_JID` in `.env`.
7. Stop the bot (Ctrl+C) and start it again.

Now share the bot's number (for example `https://wa.me/91XXXXXXXXXX?text=Hi`) on LinkedIn instead of the group link.

## How it works for a member

```
Member: Hi
Bot:    👋 Welcome to Automation Network!
        1. Join the community   2. About us   3. Talk to an admin
Member: 1
Bot:    (name, city, company, role, experience, technologies, project types,
         open to work, notice period, LinkedIn, what members may contact them for)
Bot:    ✅ You're in! Tap to join: https://chat.whatsapp.com/…
```

When the member taps the link, the bot approves them automatically. Someone who taps the link without answering gets a message asking them to say "Hi" first; their request is rejected after 72 hours.

After joining, `menu` shows:

| Option | What it does |
| --- | --- |
| 💼 Jobs | Post a job or backfill, browse open jobs, see who is interested in your posting |
| 🤝 Get a referral | Asks members who work at that company and agreed to give referrals |
| 🧠 Find an expert | Asks up to 5 members who know that technology and agreed to help |
| 👤 My profile | See or update your answers |
| ⏸ Pause | Stop receiving requests from members |

**Privacy:** before a connection, the other side sees only an anonymous card such as
`Member #M17 · 3–5 years · UiPath, Python · RPA · Bangalore`.

- Job: the candidate says yes → the poster sees the anonymous card → the poster replies `connect 12` → both get each other's contact.
- Referral / expert: the person being asked says yes → both get each other's contact.

Limits: a member receives at most 3 requests a week, can make 3 requests a day, and is not asked twice by the same person within 30 days. Requests expire after 48 hours, jobs after 30 days.

Member commands: `menu`, `!profile`, `!update`, `!pause`, `!resume`, `!report M12 reason`, `connect N`, `skip N`, `close N`.

## The daily group post

Send the bot (from an admin number):

- `!queue <text>` – add a post. To include a picture, send the image with `!queue <text>` as its caption.
- `!queue list`, `!queue del 2` – see or remove queued posts.
- `!postnow` – post the next one immediately.

Every day at 09:30 IST (change `CONTENT_CRON`) the bot posts the oldest queued item. If the queue is empty it posts nothing.

## Admin commands

Send `!admin` for the list: `!stats`, `!export` (CSV of all profiles), `!find uipath`, `!opentowork 30`, `!pending`, `!approve <number>`, `!reject <number>`, `!block <number>`, `!unblock <number>`, `!reports`, `!groups`.

## Changing the questions and texts

- `config/questions.yaml` – the joining questions. Change wording and add options freely. Don't rename `id`s or option `value`s (the matching uses them).
- `config/connect_questions.yaml` – questions for posting a job, referral and expert requests.
- `config/messages.yaml` – welcome, about and reminder texts.

Restart the bot after editing.

## Keeping it running

The bot must stay running to answer. Options:

- **A spare laptop or PC** that stays on: `npm start`.
- **A small cloud server** (for example Oracle Cloud's always-free VM). Install Node.js, copy this folder, then:

  ```bash
  npm install -g pm2
  ```

  ```bash
  pm2 start "npm start" --name automation-bot
  ```

  ```bash
  pm2 save
  ```

Back up the `data/` folder (member profiles) and `auth/` folder (the WhatsApp login). Never share them.

## Tests

```bash
npm test
```

The tests run the whole bot against a fake WhatsApp, so they need no phone: joining, bad answers, notice-period logic, auto-approval, the 72-hour rejection, job matching and anonymity, referrals, expert help, limits, the content queue and admin commands.

## Files

```
src/index.ts       start-up and timers
src/wa.ts          WhatsApp connection (Baileys)
src/bot.ts         menus and the question flow
src/flow.ts        question engine (validation, skip logic)
src/onboarding.ts  group link, auto-approve, reminders
src/connect.ts     anonymous cards, double opt-in, limits
src/jobs.ts        post, browse, match and close jobs
src/content.ts     daily post queue
src/admin.ts       admin commands and CSV export
src/db.ts          SQLite tables
```
