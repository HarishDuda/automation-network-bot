import type { Bot } from './bot.js'
import type { Answers } from './flow.js'
import type { JoinRequest, User } from './types.js'
import { HOUR, firstName, normCompany, pnJid, toCsv } from './util.js'

type Row = { jid: string; pn: string | null; created_at: number }

/** Save the answers as the member's profile, then let them into the group. */
export async function complete(bot: Bot, u: User, a: Answers, update: boolean) {
  const exp = bot.flows.onboard.find((q) => q.id === 'experience')?.options?.find((o) => o.value === a.experience)
  bot.db.run(
    `UPDATE users SET status = 'completed', name = ?, location = ?, company = ?, company_norm = ?, role = ?,
       exp = ?, exp_min = ?, exp_max = ?, techs = ?, tech_other = ?, projects = ?, open_to_work = ?, notice = ?,
       linkedin = ?, reach = ?, answers = ?, completed_at = COALESCE(completed_at, ?)
     WHERE id = ?`,
    a.name ?? null, a.location ?? null, a.company ?? null, normCompany(a.company as string), a.role ?? null,
    a.experience ?? null, exp?.min ?? 0, exp?.max ?? 60,
    toCsv(a.technologies), (a.technologies_other as string) ?? null, toCsv(a.projects),
    a.open_to_work ?? null, a.notice != null ? Number(a.notice) : null,
    a.linkedin ?? null, toCsv(a.reach), JSON.stringify(a), bot.now(), u.id,
  )
  const hint = 'Reply *menu* any time to find jobs, get a referral or ask an expert.'
  if (update) return bot.say(u, `✅ Profile updated.\n\n${hint}`)

  const name = firstName(a.name as string)
  const pending = findJoinRequest(bot, u)
  if (pending) {
    try {
      await approve(bot, pending.jid, u)
      return bot.say(u, `✅ Thanks, ${name}! Your request to join is approved. Welcome to *${bot.texts.communityName}* 🎉\n\n${hint}`)
    } catch {
      // fall through to the link
    }
  }
  await bot.say(u, `✅ Thanks, ${name}! You're all set.\n\n${await linkText(bot)}\n\n${hint}`)
}

export async function linkText(bot: Bot): Promise<string> {
  try {
    const link = await bot.t.inviteLink()
    return `Tap to join the group:\n${link}\n\n_Your request is approved automatically._`
  } catch {
    await bot.notifyAdmins("⚠️ I couldn't get the group invite link. Check GROUP_JID and that I'm an admin of the group.")
    return 'An admin will send you the group link shortly.'
  }
}

function findJoinRequest(bot: Bot, u: User): Row | undefined {
  return bot.db.get<Row>(
    'SELECT * FROM join_requests WHERE jid = ? OR jid = ? OR jid = ? OR pn = ? LIMIT 1',
    u.jid, u.lid, pnJid(u.pn), u.pn,
  )
}

async function approve(bot: Bot, jid: string, u: User) {
  await bot.t.approveJoin(jid)
  bot.db.run('DELETE FROM join_requests WHERE jid = ?', jid)
  bot.db.run('UPDATE users SET in_group = 1 WHERE id = ?', u.id)
}

/** Someone tapped the invite link. Approve if they finished the questions, otherwise ask them to. */
export async function onJoinRequest(bot: Bot, r: JoinRequest & { action: string }) {
  if (r.action !== 'created') {
    bot.db.run('DELETE FROM join_requests WHERE jid = ?', r.jid)
    return
  }
  const u = bot.findUser({ jid: r.jid, pn: r.pn, lid: r.jid.endsWith('@lid') ? r.jid : null })
  if (u?.status === 'blocked') return bot.t.rejectJoin(r.jid).catch(() => {})
  if (u?.status === 'completed') return approve(bot, r.jid, u).catch(() => {})
  if (bot.db.get('SELECT 1 FROM join_requests WHERE jid = ?', r.jid)) return
  bot.db.run('INSERT INTO join_requests (jid, pn, created_at) VALUES (?, ?, ?)', r.jid, r.pn ?? null, bot.now())
  await bot.t.sendText(pnJid(r.pn) ?? r.jid, bot.texts.nudge).catch(() => {})
}

export async function onParticipants(bot: Bot, action: string, people: { jid: string; pn?: string; lid?: string }[]) {
  if (action !== 'add' && action !== 'remove') return
  for (const p of people) {
    const u = bot.findUser(p)
    if (u) bot.db.run('UPDATE users SET in_group = ? WHERE id = ?', action === 'add' ? 1 : 0, u.id)
    if (action === 'add') {
      bot.db.run('DELETE FROM join_requests WHERE jid = ? OR jid = ? OR pn = ?', p.jid, p.lid ?? null, p.pn ?? null)
    }
  }
}

/** Pick up requests made while the bot was offline, and reject ones nobody followed up on. */
export async function sync(bot: Bot) {
  if (!bot.cfg.groupJid) return
  let live: JoinRequest[]
  try {
    live = await bot.t.listJoinRequests()
  } catch {
    return
  }
  const liveJids = new Set(live.map((r) => r.jid))
  for (const row of bot.db.all<Row>('SELECT * FROM join_requests')) {
    if (!liveJids.has(row.jid)) bot.db.run('DELETE FROM join_requests WHERE jid = ?', row.jid)
  }
  for (const r of live) await onJoinRequest(bot, { ...r, action: 'created' })

  const cutoff = bot.now() - bot.cfg.expireHours * HOUR
  for (const row of bot.db.all<Row>('SELECT * FROM join_requests WHERE created_at < ?', cutoff)) {
    await bot.t.rejectJoin(row.jid).catch(() => {})
    bot.db.run('DELETE FROM join_requests WHERE jid = ?', row.jid)
  }
}
