// Connecting members. Nobody's name, company or number is shown until both sides say yes.
import type { Bot } from './bot.js'
import type { Answers } from './flow.js'
import type { Ask, Job, Session, User } from './types.js'
import { DAY, HOUR, normCompany, sameCompany } from './util.js'
import * as jobs from './jobs.js'

type Request = { id: number; kind: 'referral' | 'expert'; requester: number; company: string | null; tech: string | null; note: string | null; status: string; created_at: number }

const OPEN = "('queued','sent')"
const MAX_HELPERS = { referral: 3, expert: 1 } as const
const ASK_LIMIT = { referral: 3, expert: 5 } as const

/** What the other side sees before a connection: no name, company or number. */
export function anonCard(bot: Bot, u: User, withNotice = false): string {
  const parts = [
    `*Member #M${u.id}*`,
    bot.optLabel('onboard', 'experience', u.exp),
    bot.labels('technologies', u.techs, u.tech_other),
    bot.labels('projects', u.projects),
    u.location,
  ]
  if (withNotice && u.open_to_work && u.open_to_work !== 'not_now') {
    parts.push(u.notice ? `notice ${u.notice} days` : 'can join immediately')
  }
  return parts.filter(Boolean).join(' · ')
}

function contactCard(u: User): string {
  return [
    `*${u.name}*`,
    `${u.role} @ ${u.company}`,
    u.pn ? `📱 https://wa.me/${u.pn}` : '📱 They will message you first.',
    ...(u.linkedin ? [`🔗 ${u.linkedin}`] : []),
  ].join('\n')
}

// ---------- limits ----------

export function canRequest(bot: Bot, u: User): boolean {
  const since = bot.now() - DAY
  const n =
    bot.db.get<{ n: number }>('SELECT COUNT(*) n FROM jobs WHERE poster = ? AND created_at > ?', u.id, since)!.n +
    bot.db.get<{ n: number }>('SELECT COUNT(*) n FROM requests WHERE requester = ? AND created_at > ?', u.id, since)!.n
  return n < bot.cfg.maxRequestsPerDay
}

export function limitText(bot: Bot): string {
  return `You've reached the limit of ${bot.cfg.maxRequestsPerDay} requests in 24 hours. Please try again tomorrow.`
}

/** Can `from` send a request to `to`? Respects pause, the weekly cap and a 30-day gap per pair. */
export function eligible(bot: Bot, from: number, to: User): boolean {
  if (to.id === from || to.status !== 'completed' || to.paused) return false
  const week = bot.db.get<{ n: number }>(
    'SELECT COUNT(*) n FROM asks WHERE to_user = ? AND self = 0 AND created_at > ?', to.id, bot.now() - 7 * DAY,
  )!.n
  if (week >= bot.cfg.maxAsksPerWeek) return false
  return !bot.db.get(
    'SELECT 1 FROM asks WHERE from_user = ? AND to_user = ? AND self = 0 AND created_at > ?', from, to.id, bot.now() - 30 * DAY,
  )
}

export function openAskCount(bot: Bot, u: User): number {
  return bot.db.get<{ n: number }>(`SELECT COUNT(*) n FROM asks WHERE to_user = ? AND self = 0 AND status IN ${OPEN}`, u.id)!.n
}

// ---------- sending a request to a member ----------

export async function createAsks(bot: Bot, kind: Ask['kind'], refId: number, from: number, targets: User[]) {
  for (const t of targets) {
    const id = bot.db.insert(
      "INSERT INTO asks (kind, ref_id, from_user, to_user, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
      kind, refId, from, t.id, bot.now(),
    )
    // Only interrupt people who aren't in the middle of something. Others see it on their menu.
    const state = bot.session(t).state
    if (state === 'idle' || state === 'menu') await show(bot, t, getAsk(bot, id)!)
  }
}

const getAsk = (bot: Bot, id: number) => bot.db.get<Ask>('SELECT * FROM asks WHERE id = ?', id)
const getRequest = (bot: Bot, id: number) => bot.db.get<Request>('SELECT * FROM requests WHERE id = ?', id)

async function show(bot: Bot, to: User, ask: Ask) {
  bot.save(to, { state: 'ask', askId: ask.id })
  bot.db.run("UPDATE asks SET status = 'sent' WHERE id = ?", ask.id)
  await bot.say(to, askText(bot, ask))
}

function askText(bot: Bot, ask: Ask): string {
  const from = bot.userById(ask.from_user)!
  if (ask.kind === 'job') {
    return [
      '💼 *A role that matches your profile*',
      '',
      jobs.card(bot, jobs.get(bot, ask.ref_id)!),
      '',
      'Interested? Your details stay private unless the poster chooses to connect with you.',
      '',
      "*1.* Yes, I'm interested",
      '*2.* No thanks',
    ].join('\n')
  }
  const req = getRequest(bot, ask.ref_id)!
  const head = ask.kind === 'referral'
    ? `🤝 *Referral request*\n\nA member would like a referral at *${req.company}*.`
    : `🧠 *A member needs help with ${bot.optLabel('onboard', 'technologies', req.tech)}*`
  return [
    head,
    ...(req.note ? [`“${req.note}”`] : []),
    '',
    anonCard(bot, from),
    '',
    "Can you help? If you say yes, you'll both get each other's contact.",
    '',
    '*1.* Yes, connect us',
    '*2.* No thanks',
  ].join('\n')
}

/** Show the oldest request that is waiting for this member. */
export async function presentNext(bot: Bot, u: User, prefix = '') {
  const ask = bot.db.get<Ask>(`SELECT * FROM asks WHERE to_user = ? AND self = 0 AND status IN ${OPEN} ORDER BY id LIMIT 1`, u.id)
  if (!ask) return bot.showMenu(u, prefix || 'No requests are waiting for you.\n\n')
  if (prefix) await bot.say(u, prefix.trim())
  return show(bot, u, ask)
}

async function afterAnswer(bot: Bot, u: User, reply: string) {
  bot.save(u, { state: 'menu' })
  if (openAskCount(bot, u)) return presentNext(bot, u, reply)
  await bot.say(u, `${reply}\n\n_Reply *menu* for more._`)
}

export async function answerAsk(bot: Bot, u: User, s: Session, lower: string) {
  const ask = s.askId ? getAsk(bot, s.askId) : undefined
  if (!ask || (ask.status !== 'queued' && ask.status !== 'sent')) {
    return bot.showMenu(u, 'That request is no longer open.\n\n')
  }
  const yes = ['1', 'yes', 'y'].includes(lower)
  const no = ['2', 'no', 'n'].includes(lower)
  if (!yes && !no) return bot.say(u, askText(bot, ask))
  if (no) {
    setStatus(bot, ask.id, 'no')
    return afterAnswer(bot, u, 'No problem 👍')
  }

  if (ask.kind === 'job') {
    const job = jobs.get(bot, ask.ref_id)!
    if (job.status !== 'open') {
      setStatus(bot, ask.id, 'expired')
      return afterAnswer(bot, u, 'This role has just been closed. Thanks anyway!')
    }
    setStatus(bot, ask.id, 'yes')
    await notifyInterested(bot, getAsk(bot, ask.id)!, job, u)
    return afterAnswer(bot, u, "👍 Noted. The poster now knows a matching member is interested. If they choose to connect, you'll both get each other's contact.")
  }

  const req = getRequest(bot, ask.ref_id)!
  const helpers = () => bot.db.get<{ n: number }>("SELECT COUNT(*) n FROM asks WHERE kind = ? AND ref_id = ? AND status = 'connected'", ask.kind, req.id)!.n
  if (req.status !== 'open' || helpers() >= MAX_HELPERS[ask.kind]) {
    setStatus(bot, ask.id, 'expired')
    return afterAnswer(bot, u, 'Thank you! Someone has already helped with this one.')
  }
  await doConnect(bot, ask)
  if (helpers() >= MAX_HELPERS[ask.kind]) closeRequest(bot, req)
  return afterAnswer(bot, u, 'Thanks for helping 🙌')
}

function setStatus(bot: Bot, id: number, status: Ask['status']) {
  bot.db.run('UPDATE asks SET status = ?, answered_at = ? WHERE id = ?', status, bot.now(), id)
}

function closeRequest(bot: Bot, req: Request) {
  bot.db.run("UPDATE requests SET status = 'closed' WHERE id = ?", req.id)
  bot.db.run(`UPDATE asks SET status = 'expired' WHERE kind = ? AND ref_id = ? AND status IN ${OPEN}`, req.kind, req.id)
}

/** Tell the job poster that a member (shown anonymously) is interested. */
export async function notifyInterested(bot: Bot, ask: Ask, job: Job, candidate: User) {
  const poster = bot.userById(job.poster)!
  await bot.say(poster, [
    `🙋 *A member is interested in Job #${job.id}* (${job.role} @ ${job.company})`,
    '',
    anonCard(bot, candidate, true),
    '',
    `Reply *connect ${ask.id}* to exchange contacts, or *skip ${ask.id}*.`,
  ].join('\n'))
}

// ---------- the connection itself ----------

async function doConnect(bot: Bot, ask: Ask) {
  const from = bot.userById(ask.from_user)!
  const to = bot.userById(ask.to_user)!
  setStatus(bot, ask.id, 'connected')
  bot.db.run('INSERT INTO connections (ask_id, a, b, kind, created_at) VALUES (?, ?, ?, ?, ?)', ask.id, from.id, to.id, ask.kind, bot.now())
  let forFrom: string, forTo: string
  if (ask.kind === 'job') {
    const job = jobs.get(bot, ask.ref_id)!
    forFrom = `Here is the member interested in Job #${job.id}:`
    forTo = `The person who posted Job #${job.id} (${job.role} @ ${job.company}) wants to talk to you:`
  } else if (ask.kind === 'referral') {
    forFrom = 'This member is happy to help with your referral request:'
    forTo = 'Here is the member who asked for a referral:'
  } else {
    forFrom = 'This member can help with your question:'
    forTo = 'Here is the member who asked for help:'
  }
  await bot.say(from, `🎉 *You're connected!*\n${forFrom}\n\n${contactCard(to)}`)
  await bot.say(to, `🎉 *You're connected!*\n${forTo}\n\n${contactCard(from)}`)
}

function posterAsk(bot: Bot, u: User, id: number): Ask | undefined {
  const ask = getAsk(bot, id)
  return ask && ask.kind === 'job' && ask.from_user === u.id && ask.status === 'yes' ? ask : undefined
}

export async function connectCommand(bot: Bot, u: User, id: number) {
  const ask = posterAsk(bot, u, id)
  if (!ask) return bot.say(u, "I couldn't find an interested member with that number. Check *My postings* under Jobs.")
  await doConnect(bot, ask)
}

export async function skipCommand(bot: Bot, u: User, id: number) {
  const ask = posterAsk(bot, u, id)
  if (!ask) return bot.say(u, "I couldn't find an interested member with that number.")
  setStatus(bot, ask.id, 'no')
  await bot.say(u, 'Skipped.')
}

// ---------- referral and expert requests ----------

export async function startRequest(bot: Bot, u: User, kind: 'referral' | 'expert', a: Answers) {
  if (!canRequest(bot, u)) return bot.say(u, limitText(bot))
  const company = kind === 'referral' ? (a.company as string) : null
  const tech = kind === 'expert' ? (a.tech as string) : null
  const id = bot.db.insert(
    'INSERT INTO requests (kind, requester, company, tech, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    kind, u.id, company, tech, (a.note as string) ?? null, bot.now(),
  )
  const pool = kind === 'referral'
    ? bot.db.all<User>("SELECT * FROM users WHERE status = 'completed' AND reach LIKE '%,referrals,%' ORDER BY RANDOM()")
        .filter((t) => sameCompany(normCompany(company), t.company_norm))
    : bot.db.all<User>("SELECT * FROM users WHERE status = 'completed' AND reach LIKE '%,mentoring,%' AND techs LIKE ? ORDER BY exp_min DESC, RANDOM()", `%,${tech},%`)
  const targets = pool.filter((t) => eligible(bot, u.id, t)).slice(0, ASK_LIMIT[kind])

  if (!targets.length) {
    bot.db.run("UPDATE requests SET status = 'closed' WHERE id = ?", id)
    return bot.say(u, kind === 'referral'
      ? `I couldn't find a member at *${company}* who is available for referrals right now. Try again in a few days as more people join.\n\n_Reply *menu* for more._`
      : "I couldn't find an available member for that topic right now. Try again in a few days.\n\n_Reply *menu* for more._")
  }
  await bot.say(u, `✅ Sent privately to ${targets.length} member${targets.length > 1 ? 's' : ''}. They only see your anonymous profile. I'll message you as soon as someone says yes (requests expire after ${bot.cfg.askExpireHours} hours).`)
  await createAsks(bot, kind, id, u.id, targets)
}

export async function report(bot: Bot, u: User, arg: string) {
  const m = arg.match(/^#?m?(\d+)\s*(.*)$/is)
  const target = m ? bot.userById(Number(m[1])) : undefined
  if (!m || !target) return bot.say(u, 'To report a member, reply like this: *!report M12 what happened*')
  bot.db.run('INSERT INTO reports (reporter, target, reason, created_at) VALUES (?, ?, ?, ?)', u.id, target.id, m[2] || null, bot.now())
  await bot.say(u, 'Thank you. The admins will look into it.')
  await bot.notifyAdmins(`🚩 Report: #M${u.id} (${u.name}) reported #M${target.id} (${target.name}, ${target.pn ?? 'number hidden'})\nReason: ${m[2] || '(none given)'}`)
}

/** Old unanswered requests expire, and the requester is told if nobody could help. */
export async function expire(bot: Bot) {
  const cutoff = bot.now() - bot.cfg.askExpireHours * HOUR
  bot.db.run(`UPDATE asks SET status = 'expired' WHERE status IN ${OPEN} AND created_at < ?`, cutoff)
  for (const req of bot.db.all<Request>("SELECT * FROM requests WHERE status = 'open' AND created_at < ?", cutoff)) {
    bot.db.run("UPDATE requests SET status = 'closed' WHERE id = ?", req.id)
    const helped = bot.db.get("SELECT 1 FROM asks WHERE kind = ? AND ref_id = ? AND status = 'connected'", req.kind, req.id)
    const requester = bot.userById(req.requester)
    if (!helped && requester) {
      await bot.say(requester, req.kind === 'referral'
        ? `Nobody was available for your referral request at *${req.company}* this time. You can try again from the menu.`
        : 'Nobody was available to help with your question this time. You can try again from the menu.')
    }
  }
}
