import type { Bot } from './bot.js'
import type { Incoming, User } from './types.js'
import { HOUR, digits, fromCsv } from './util.js'
import * as content from './content.js'

const HELP = [
  '*Admin commands*',
  '• *!stats*: members, open to work, top technologies',
  '• *!export*: all profiles as a CSV file',
  '• *!find uipath*: members who use a technology',
  '• *!opentowork 30*: members open to work (optional: max notice in days)',
  '• *!pending*: join requests waiting on the questions',
  '• *!approve 9198…* / *!reject 9198…*: decide a join request yourself',
  '• *!block 9198…* / *!unblock 9198…*',
  '• *!queue <text>*: add a post for the group (send an image with this as the caption to include it)',
  '• *!queue list*, *!queue del 2*, *!postnow*',
  '• *!reports*: recent member reports',
  '• *!groups*: list my groups and their IDs',
].join('\n')

const line = (bot: Bot, u: User) =>
  `#M${u.id} ${u.name} · ${u.role} @ ${u.company} · ${bot.optLabel('onboard', 'experience', u.exp)}${u.pn ? ` · +${u.pn}` : ''}`

const byNumber = (bot: Bot, arg: string) => {
  const d = digits(arg)
  return d.length >= 7 ? bot.db.get<User>('SELECT * FROM users WHERE pn LIKE ?', `%${d}`) : undefined
}

/** Returns true if the message was an admin command. */
export async function handle(bot: Bot, u: User, text: string, m: Incoming): Promise<boolean> {
  const cmd = text.slice(1).trim().split(/\s+/)[0].toLowerCase()
  const arg = text.slice(1).trim().slice(cmd.length).trim()
  const db = bot.db
  const reply = (t: string) => bot.say(u, t)
  const count = (sql: string, ...p: any[]) => db.get<{ n: number }>(sql, ...p)!.n

  switch (cmd) {
    case 'admin':
      await reply(HELP)
      return true

    case 'stats': {
      const members = db.all<User>("SELECT * FROM users WHERE status = 'completed'")
      const tally = new Map<string, number>()
      for (const x of members) for (const t of fromCsv(x.techs)) tally.set(t, (tally.get(t) ?? 0) + 1)
      const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 5)
      await reply([
        '*📊 Stats*',
        `Profiles completed: ${members.length}`,
        `In the group: ${members.filter((x) => x.in_group).length}`,
        `Open to work: ${members.filter((x) => x.open_to_work && x.open_to_work !== 'not_now').length}`,
        `Started but not finished: ${count("SELECT COUNT(*) n FROM users WHERE status = 'new' AND session LIKE '%answers%'")}`,
        `Open jobs: ${count("SELECT COUNT(*) n FROM jobs WHERE status = 'open'")}`,
        `Connections made: ${count('SELECT COUNT(*) n FROM connections')}`,
        `Posts in queue: ${content.pending(bot).length}`,
        '',
        '*Top technologies*',
        ...(top.length ? top.map(([t, n]) => `• ${bot.optLabel('onboard', 'technologies', t)}: ${n}`) : ['(none yet)']),
      ].join('\n'))
      return true
    }

    case 'export': {
      const rows = db.all<User>("SELECT * FROM users WHERE status = 'completed' ORDER BY id")
      const cols = ['id', 'name', 'phone', 'location', 'company', 'role', 'experience', 'technologies', 'projects', 'open_to_work', 'notice_days', 'linkedin', 'reach', 'in_group', 'joined']
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const csv = [cols.join(',')].concat(rows.map((x) => [
        `M${x.id}`, x.name, x.pn ? `+${x.pn}` : '', x.location, x.company, x.role,
        bot.optLabel('onboard', 'experience', x.exp), bot.labels('technologies', x.techs, x.tech_other),
        bot.labels('projects', x.projects), bot.optLabel('onboard', 'open_to_work', x.open_to_work),
        x.notice ?? '', x.linkedin, bot.labels('reach', x.reach), x.in_group ? 'yes' : 'no',
        x.completed_at ? new Date(x.completed_at).toISOString().slice(0, 10) : '',
      ].map(esc).join(','))).join('\r\n')
      await bot.t.sendDocument(u.jid, Buffer.from('﻿' + csv, 'utf8'), 'automation-network-members.csv', 'text/csv')
      await reply(`Sent ${rows.length} profile${rows.length === 1 ? '' : 's'}.`)
      return true
    }

    case 'find': {
      if (!arg) return reply('Example: *!find uipath*').then(() => true)
      const q = arg.toLowerCase()
      const opts = bot.flows.onboard.find((x) => x.id === 'technologies')?.options ?? []
      const values = opts.filter((o) => o.value.includes(q) || o.label.toLowerCase().includes(q)).map((o) => o.value)
      const hits = db.all<User>("SELECT * FROM users WHERE status = 'completed' ORDER BY exp_min DESC")
        .filter((x) => fromCsv(x.techs).some((t) => values.includes(t)) || (x.tech_other ?? '').toLowerCase().includes(q))
      await reply(hits.length
        ? [`*${hits.length} member${hits.length > 1 ? 's' : ''} with "${arg}"*`, ...hits.slice(0, 25).map((x) => line(bot, x))].join('\n')
        : `No members found with "${arg}".`)
      return true
    }

    case 'opentowork': {
      const max = /^\d+$/.test(arg) ? Number(arg) : 9999
      const hits = db.all<User>(
        "SELECT * FROM users WHERE status = 'completed' AND open_to_work IN ('full_time', 'freelance') AND COALESCE(notice, 0) <= ? ORDER BY COALESCE(notice, 0), exp_min DESC", max,
      )
      await reply(hits.length
        ? [`*${hits.length} open to work*`, ...hits.slice(0, 25).map((x) => `${line(bot, x)} · ${x.notice ? `${x.notice}d notice` : 'immediate'}`)].join('\n')
        : 'Nobody matches that right now.')
      return true
    }

    case 'pending': {
      const rows = db.all<{ jid: string; pn: string | null; created_at: number }>('SELECT * FROM join_requests ORDER BY created_at')
      await reply(rows.length
        ? ['*Join requests waiting on the questions*', ...rows.map((r) => `• ${r.pn ? `+${r.pn}` : r.jid} · ${Math.round((bot.now() - r.created_at) / HOUR)}h ago`)].join('\n')
        : 'No join requests are waiting.')
      return true
    }

    case 'approve':
    case 'reject': {
      const d = digits(arg)
      const row = d.length >= 7 ? db.get<{ jid: string }>('SELECT * FROM join_requests WHERE pn LIKE ?', `%${d}`) : undefined
      if (!row) return reply("I don't see a join request from that number. Check *!pending*.").then(() => true)
      try {
        if (cmd === 'approve') await bot.t.approveJoin(row.jid)
        else await bot.t.rejectJoin(row.jid)
        db.run('DELETE FROM join_requests WHERE jid = ?', row.jid)
        await reply(cmd === 'approve' ? 'Approved.' : 'Rejected.')
      } catch {
        await reply("That didn't work. Am I still an admin of the group?")
      }
      return true
    }

    case 'block':
    case 'unblock': {
      const target = byNumber(bot, arg)
      if (!target) return reply("I don't know that number.").then(() => true)
      const status = cmd === 'block' ? 'blocked' : target.completed_at ? 'completed' : 'new'
      db.run('UPDATE users SET status = ? WHERE id = ?', status, target.id)
      await reply(cmd === 'block' ? `Blocked #M${target.id}. I won't reply to them or let them join.` : `Unblocked #M${target.id}.`)
      return true
    }

    case 'queue': {
      const sub = arg.toLowerCase()
      if (!arg || sub === 'list') {
        const items = content.pending(bot)
        await reply(items.length
          ? ['*Posts in queue* (the first one goes out next)', ...items.map((it, i) => `*${i + 1}.* ${it.media ? '🖼 ' : ''}${it.text.slice(0, 80)}${it.text.length > 80 ? '…' : ''}`)].join('\n')
          : 'The queue is empty. Add a post with *!queue <text>*.')
        return true
      }
      const del = sub.match(/^del\s+(\d+)$/)
      if (del) {
        const item = content.pending(bot)[Number(del[1]) - 1]
        if (item) db.run('DELETE FROM content_queue WHERE id = ?', item.id)
        await reply(item ? 'Removed.' : "There's no post with that number.")
        return true
      }
      const n = content.enqueue(bot, arg, m.mediaPath)
      await reply(`Queued. ${n} post${n > 1 ? 's' : ''} waiting.`)
      return true
    }

    case 'postnow': {
      try {
        await reply((await content.postNext(bot)) ? 'Posted to the group.' : 'The queue is empty.')
      } catch {
        await reply("I couldn't post to the group. Check GROUP_JID and that I'm in the group.")
      }
      return true
    }

    case 'reports': {
      const rows = db.all<{ reporter: number; target: number; reason: string | null; created_at: number }>('SELECT * FROM reports ORDER BY id DESC LIMIT 10')
      await reply(rows.length
        ? ['*Recent reports*', ...rows.map((r) => `• #M${r.reporter} → #M${r.target}: ${r.reason ?? '(no reason)'}`)].join('\n')
        : 'No reports.')
      return true
    }

    case 'groups': {
      const groups = await bot.t.listGroups()
      await reply(groups.length
        ? ['*My groups*', ...groups.map((g) => `• ${g.subject}\n  ${g.id}`), '', 'Copy the ID of your group into GROUP_JID in the .env file and restart me.'].join('\n')
        : "I'm not in any groups yet. Add me to the group and make me an admin.")
      return true
    }
  }
  return false
}
