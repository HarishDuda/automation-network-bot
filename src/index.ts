import cron from 'node-cron'
import { Bot } from './bot.js'
import { loadFlows, loadSettings, loadTexts } from './config.js'
import * as content from './content.js'
import { Db } from './db.js'
import { Wa } from './wa.js'

const cfg = loadSettings()
const db = new Db('data/bot.db')
const wa = new Wa(cfg)
const bot = new Bot(db, wa, cfg, loadTexts(), loadFlows())

const safely = (what: string, job: () => Promise<unknown>) => () => {
  job().catch((e) => console.error(`${what} failed:`, e?.message ?? e))
}

wa.handlers = {
  message: (m) => bot.onMessage(m),
  joinRequest: (r) => bot.onJoinRequest(r),
  participants: (action, people) => bot.onParticipants(action, people),
  ready: () => bot.tick(),
}

if (!cfg.adminNumbers.length) console.warn('⚠️  ADMIN_NUMBERS is empty: nobody can use the admin commands.')
if (!cfg.groupJid) console.warn('⚠️  GROUP_JID is empty. Message the bot "!groups" from an admin number, put the ID in .env, and restart.')
if (!cron.validate(cfg.contentCron)) throw new Error(`CONTENT_CRON is not a valid schedule: "${cfg.contentCron}"`)

// Housekeeping: missed join requests, expired requests and jobs.
cron.schedule('*/15 * * * *', safely('Housekeeping', () => bot.tick()))
// The daily group post. Nothing is posted when the queue is empty.
cron.schedule(cfg.contentCron, safely('Daily post', async () => {
  if (cfg.groupJid) await content.postNext(bot)
}), { timezone: cfg.tz })

await wa.start()
