import type { Bot } from './bot.js'
import type { Answers } from './flow.js'
import type { Ask, Job, Session, User } from './types.js'
import { DAY, fromCsv, toCsv } from './util.js'
import * as connect from './connect.js'

const TYPE: Record<string, string> = { backfill: 'Backfill', new: 'New opening', referral: 'Referral' }

export const get = (bot: Bot, id: number) => bot.db.get<Job>('SELECT * FROM jobs WHERE id = ?', id)

const expText = (j: Job) => (j.exp_min === j.exp_max ? `${j.exp_min} yrs` : `${j.exp_min}–${j.exp_max} yrs`)

/** The job as members see it. The poster is never named. */
export function card(bot: Bot, j: Job): string {
  const notice = j.max_notice >= 999 ? 'Any notice period' : j.max_notice === 0 ? 'Immediate joiners only' : `Notice up to ${j.max_notice} days`
  return [
    `*Job #${j.id} · ${j.role} @ ${j.company}* (${TYPE[j.type] ?? j.type})`,
    [bot.labels('technologies', j.techs, j.tech_other), expText(j), j.location, notice].filter(Boolean).join(' · '),
    ...(j.details ? [j.details] : []),
  ].join('\n')
}

export async function menu(bot: Bot, u: User, prefix = '') {
  bot.save(u, { state: 'jobs' })
  await bot.say(u, `${prefix}*💼 Jobs*\n\n*1.* Browse open jobs\n*2.* Post a job\n*3.* My postings\n*0.* Back`)
}

export async function handle(bot: Bot, u: User, s: Session, lower: string) {
  if (s.state === 'jobs') {
    if (lower === '1') return browse(bot, u)
    if (lower === '2') {
      if (!connect.canRequest(bot, u)) return bot.say(u, connect.limitText(bot))
      return bot.startFlow(u, 'job')
    }
    if (lower === '3') return mine(bot, u)
    if (lower === '0') return bot.showMenu(u)
    return menu(bot, u)
  }
  if (s.state === 'browse') {
    const id = /^\d+$/.test(lower) ? s.ids?.[Number(lower) - 1] : undefined
    return id ? view(bot, u, id) : menu(bot, u)
  }
  if (lower === '1' && s.jobId) return apply(bot, u, s.jobId)
  return browse(bot, u)
}

async function browse(bot: Bot, u: User) {
  const list = bot.db.all<Job>("SELECT * FROM jobs WHERE status = 'open' AND poster != ? ORDER BY id DESC LIMIT 10", u.id)
  if (!list.length) return menu(bot, u, 'There are no open jobs right now.\n\n')
  bot.save(u, { state: 'browse', ids: list.map((j) => j.id) })
  await bot.say(u, [
    '*Open jobs*',
    '',
    ...list.map((j, i) => `*${i + 1}.* ${j.role} @ ${j.company} · ${expText(j)} · ${j.location}`),
    '',
    '_Reply with a number to see details, or *0* to go back._',
  ].join('\n'))
}

const myAsk = (bot: Bot, u: User, jobId: number) =>
  bot.db.get<Ask>("SELECT * FROM asks WHERE kind = 'job' AND ref_id = ? AND to_user = ? ORDER BY id DESC LIMIT 1", jobId, u.id)

async function view(bot: Bot, u: User, id: number) {
  const job = get(bot, id)
  if (!job || job.status !== 'open') return browse(bot, u)
  bot.save(u, { state: 'jobview', jobId: id })
  const prior = myAsk(bot, u, id)
  const done = prior && ['yes', 'connected'].includes(prior.status)
  await bot.say(u, `${card(bot, job)}\n\n${done ? "_You've already shown interest in this one._" : "*1.* I'm interested"}\n*0.* Back`)
}

async function apply(bot: Bot, u: User, jobId: number) {
  const job = get(bot, jobId)
  if (!job || job.status !== 'open') return menu(bot, u, 'That job has been closed.\n\n')
  const prior = myAsk(bot, u, jobId)
  if (prior && ['yes', 'connected'].includes(prior.status)) return menu(bot, u, "You've already shown interest in this job.\n\n")
  let askId: number
  if (prior && ['queued', 'sent'].includes(prior.status)) {
    bot.db.run("UPDATE asks SET status = 'yes', answered_at = ? WHERE id = ?", bot.now(), prior.id)
    askId = prior.id
  } else {
    askId = bot.db.insert(
      "INSERT INTO asks (kind, ref_id, from_user, to_user, status, self, created_at, answered_at) VALUES ('job', ?, ?, ?, 'yes', 1, ?, ?)",
      jobId, job.poster, u.id, bot.now(), bot.now(),
    )
  }
  await connect.notifyInterested(bot, bot.db.get<Ask>('SELECT * FROM asks WHERE id = ?', askId)!, job, u)
  await menu(bot, u, "👍 Done. The poster sees only your anonymous profile. If they choose to connect, you'll both get each other's contact.\n\n")
}

/** Members who are open to work and fit the job's technology, experience and notice period. */
export function match(bot: Bot, job: Job): User[] {
  const wanted = fromCsv(job.techs)
  return bot.db
    .all<User>(
      `SELECT * FROM users WHERE status = 'completed' AND open_to_work IN ('full_time', 'freelance')
         AND reach LIKE '%,jobs,%' AND exp_min <= ? AND exp_max >= ? AND COALESCE(notice, 0) <= ?
       ORDER BY RANDOM()`,
      job.exp_max, job.exp_min, job.max_notice,
    )
    .filter((c) => !wanted.length || fromCsv(c.techs).some((t) => wanted.includes(t)))
    .filter((c) => connect.eligible(bot, job.poster, c))
    .slice(0, bot.cfg.jobMatchLimit)
}

export async function publish(bot: Bot, u: User, a: Answers) {
  if (!connect.canRequest(bot, u)) return bot.say(u, connect.limitText(bot))
  const id = bot.db.insert(
    `INSERT INTO jobs (poster, company, role, type, techs, tech_other, exp_min, exp_max, location, max_notice, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    u.id, a.company, a.role, a.type, toCsv(a.technologies), (a.technologies_other as string) ?? null,
    Number(a.exp_min), Number(a.exp_max), a.location, Number(a.max_notice), a.details ?? null, bot.now(),
  )
  const job = get(bot, id)!
  const targets = match(bot, job)
  await bot.say(u, [
    `✅ *Job #${id} is live.* Your name is not shown on it.`,
    '',
    card(bot, job),
    '',
    targets.length
      ? `I've sent it privately to ${targets.length} matching member${targets.length > 1 ? 's' : ''}. I'll message you when someone is interested.`
      : "No members match it right now. It's listed under *Browse open jobs*, so members can still find it.",
    `Reply *close ${id}* when it's filled.`,
  ].join('\n'))
  await connect.createAsks(bot, 'job', id, u.id, targets)
}

async function mine(bot: Bot, u: User) {
  const list = bot.db.all<Job>("SELECT * FROM jobs WHERE poster = ? AND status = 'open' ORDER BY id DESC LIMIT 10", u.id)
  if (!list.length) return menu(bot, u, "You don't have any open postings.\n\n")
  const lines: string[] = ['*Your open postings*']
  for (const j of list) {
    const asks = bot.db.all<Ask>("SELECT * FROM asks WHERE kind = 'job' AND ref_id = ? AND status IN ('yes', 'connected')", j.id)
    const waiting = asks.filter((x) => x.status === 'yes')
    lines.push('', `*Job #${j.id}* · ${j.role} @ ${j.company} · ${asks.length - waiting.length} connected`)
    for (const x of waiting) {
      lines.push(`   • ${connect.anonCard(bot, bot.userById(x.to_user)!, true)}\n     → reply *connect ${x.id}*`)
    }
  }
  lines.push('', '_Reply *close <job number>* to close a job, or *0* to go back._')
  bot.save(u, { state: 'jobs' })
  await bot.say(u, lines.join('\n'))
}

function shut(bot: Bot, id: number) {
  bot.db.run("UPDATE jobs SET status = 'closed' WHERE id = ?", id)
  bot.db.run("UPDATE asks SET status = 'expired' WHERE kind = 'job' AND ref_id = ? AND status IN ('queued', 'sent', 'yes')", id)
}

export async function close(bot: Bot, u: User, id: number) {
  const job = get(bot, id)
  if (!job || job.status !== 'open' || (job.poster !== u.id && !bot.isAdmin(u))) {
    return bot.say(u, "I couldn't find an open job of yours with that number.")
  }
  shut(bot, id)
  await bot.say(u, `Job #${id} is closed. Thanks for posting it!`)
}

export async function expire(bot: Bot) {
  const cutoff = bot.now() - bot.cfg.jobExpireDays * DAY
  for (const job of bot.db.all<Job>("SELECT * FROM jobs WHERE status = 'open' AND created_at < ?", cutoff)) {
    shut(bot, job.id)
    const poster = bot.userById(job.poster)
    if (poster) await bot.say(poster, `Job #${job.id} (${job.role} @ ${job.company}) was closed automatically after ${bot.cfg.jobExpireDays} days. Post it again if it's still open.`)
  }
}
