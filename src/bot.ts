import type { Db } from './db.js'
import { type Question, nextQuestion, parseAnswer, prune, renderQuestion, summarize, visible } from './flow.js'
import type { FlowName, Incoming, JoinRequest, Session, Settings, Texts, Transport, User } from './types.js'
import { fromCsv, pnJid } from './util.js'
import * as onboarding from './onboarding.js'
import * as connect from './connect.js'
import * as jobs from './jobs.js'
import * as admin from './admin.js'

const GREETINGS = new Set(['hi', 'hii', 'hello', 'hey', 'hai', 'start', 'namaste'])
const TITLES: Record<FlowName, string> = {
  onboard: 'your profile',
  job: 'the job',
  referral: 'your referral request',
  expert: 'your request',
}

export class Bot {
  /** Overridden in tests to move time forward. */
  now: () => number = () => Date.now()

  constructor(
    public db: Db,
    public t: Transport,
    public cfg: Settings,
    public texts: Texts,
    public flows: Record<FlowName, Question[]>,
  ) {}

  // ---------- users and sessions ----------

  findUser(k: { jid?: string; pn?: string | null; lid?: string | null }): User | undefined {
    return this.db.get<User>(
      'SELECT * FROM users WHERE jid = ? OR jid = ? OR jid = ? OR pn = ? OR lid = ? ORDER BY id LIMIT 1',
      k.jid ?? null, k.lid ?? null, pnJid(k.pn), k.pn ?? null, k.lid ?? null,
    )
  }

  /** Find or create the user behind an incoming message and remember where to reply. */
  touchUser(m: Incoming): User {
    const found = this.findUser(m)
    if (!found) {
      const id = this.db.insert(
        'INSERT INTO users (jid, pn, lid, created_at) VALUES (?, ?, ?, ?)',
        m.jid, m.pn ?? null, m.lid ?? null, this.now(),
      )
      return this.userById(id)!
    }
    if (found.jid !== m.jid || (m.pn && found.pn !== m.pn) || (m.lid && found.lid !== m.lid)) {
      this.db.run(
        'UPDATE users SET jid = ?, pn = COALESCE(?, pn), lid = COALESCE(?, lid) WHERE id = ?',
        m.jid, m.pn ?? null, m.lid ?? null, found.id,
      )
      return this.userById(found.id)!
    }
    return found
  }

  userById(id: number): User | undefined {
    return this.db.get<User>('SELECT * FROM users WHERE id = ?', id)
  }

  session(u: User): Session {
    const fresh = this.userById(u.id)
    return fresh?.session ? (JSON.parse(fresh.session) as Session) : { state: 'idle' }
  }

  save(u: User, s: Session) {
    this.db.run('UPDATE users SET session = ? WHERE id = ?', JSON.stringify(s), u.id)
  }

  isAdmin(u: User): boolean {
    return !!u.pn && this.cfg.adminNumbers.includes(u.pn)
  }

  async say(u: User, text: string) {
    await this.t.sendText(u.jid, text)
  }

  async notifyAdmins(text: string) {
    for (const n of this.cfg.adminNumbers) {
      await this.t.sendText(pnJid(n)!, text).catch(() => {})
    }
  }

  optLabel(flow: FlowName, qid: string, value?: string | null): string {
    if (value == null) return ''
    return this.flows[flow].find((q) => q.id === qid)?.options?.find((o) => o.value === value)?.label ?? value
  }

  labels(qid: string, csv?: string | null, other?: string | null): string {
    return [...fromCsv(csv).map((v) => this.optLabel('onboard', qid, v)), ...(other ? [other] : [])].join(', ')
  }

  // ---------- incoming message ----------

  async onMessage(m: Incoming) {
    const u = this.touchUser(m)
    if (u.status === 'blocked') return
    const text = m.text.trim()
    if (!text) return
    const lower = text.toLowerCase()
    const s = this.session(u)

    if (lower.startsWith('!')) {
      if (this.isAdmin(u) && (await admin.handle(this, u, text, m))) return
      if (await this.memberCommand(u, lower, text)) return
      await this.say(u, "I don't know that command. Reply *menu* to see what I can do.")
      return
    }

    if (u.status === 'completed') {
      const g = lower.match(/^(connect|skip|close)\s+#?(\d+)$/)
      if (g) {
        const n = Number(g[2])
        if (g[1] === 'connect') return connect.connectCommand(this, u, n)
        if (g[1] === 'skip') return connect.skipCommand(this, u, n)
        return jobs.close(this, u, n)
      }
    }

    if (lower === 'menu' || lower === 'cancel' || (GREETINGS.has(lower) && s.state !== 'q')) {
      return this.showMenu(u)
    }

    switch (s.state) {
      case 'q':
        return this.onQuestionReply(u, s, text, lower)
      case 'confirm':
        return this.onConfirmReply(u, s, lower)
      case 'edit':
        return this.onEditReply(u, s, lower)
      case 'ask':
        return connect.answerAsk(this, u, s, lower)
      case 'jobs':
      case 'browse':
      case 'jobview':
        return jobs.handle(this, u, s, lower)
      case 'profile':
        return this.onProfileReply(u, lower)
      case 'menu':
        return this.onMenuReply(u, s, lower)
      default:
        return this.showMenu(u)
    }
  }

  private async memberCommand(u: User, lower: string, text: string): Promise<boolean> {
    const cmd = lower.split(/\s+/)[0]
    if (!['!profile', '!update', '!pause', '!resume', '!report', '!help'].includes(cmd)) return false
    if (u.status !== 'completed') {
      await this.showMenu(u)
      return true
    }
    if (cmd === '!profile') await this.showProfile(u)
    else if (cmd === '!update') await this.startUpdate(u)
    else if (cmd === '!pause' || cmd === '!resume') await this.setPaused(u, cmd === '!pause')
    else if (cmd === '!report') await connect.report(this, u, text.slice(cmd.length).trim())
    else {
      await this.say(u, [
        '*What you can send me*',
        '• *menu*: jobs, referrals, experts, your profile',
        '• *!profile* / *!update*: see or change your details',
        '• *!pause* / *!resume*: stop or restart requests from other members',
        '• *!report M12 reason*: report a member to the admins',
      ].join('\n'))
    }
    return true
  }

  // ---------- menus ----------

  /** Leaving a flow: a half-finished joining form is kept, anything else is dropped. */
  private menuSession(u: User): Session {
    const s = this.session(u)
    if (u.status === 'new' && s.flow === 'onboard') {
      return { state: 'menu', flow: 'onboard', answers: s.answers, order: s.order }
    }
    return { state: 'menu' }
  }

  async showMenu(u: User, prefix = '') {
    const s = this.menuSession(u)
    this.save(u, s)
    if (u.status === 'new') {
      const started = Object.keys(s.answers ?? {}).length > 0
      await this.say(u, [
        prefix + this.texts.welcome,
        '',
        `*1.* ${started ? 'Continue joining' : 'Join the community'}`,
        '*2.* About us',
        '*3.* Talk to an admin',
        '',
        '_Reply with a number._',
      ].join('\n'))
      return
    }
    const waiting = connect.openAskCount(this, u)
    await this.say(u, [
      `${prefix}*${this.texts.communityName}*`,
      '',
      '*1.* 💼 Jobs',
      '*2.* 🤝 Get a referral',
      '*3.* 🧠 Find an expert',
      '*4.* 👤 My profile',
      `*5.* ${u.paused ? '▶️ Resume requests from members' : '⏸ Pause requests from members'}`,
      '*6.* 🔗 Group link',
      ...(waiting ? [`*0.* 📬 ${waiting} request${waiting > 1 ? 's' : ''} waiting for you`] : []),
      '',
      '_Reply with a number._',
    ].join('\n'))
  }

  private async onMenuReply(u: User, s: Session, lower: string) {
    if (u.status === 'new') {
      if (lower === '1') return this.startFlow(u, 'onboard')
      if (lower === '2') return this.say(u, `${this.texts.about}\n\nReply *1* to join.`)
      if (lower === '3') {
        await this.say(u, this.texts.adminContact)
        await this.notifyAdmins(`💬 Someone who hasn't joined yet wants to talk to an admin: https://wa.me/${u.pn ?? '(number hidden)'}`)
        return
      }
      return this.showMenu(u)
    }
    switch (lower) {
      case '1':
        return jobs.menu(this, u)
      case '2':
      case '3': {
        if (!connect.canRequest(this, u)) return this.say(u, connect.limitText(this))
        return this.startFlow(u, lower === '2' ? 'referral' : 'expert')
      }
      case '4':
        return this.showProfile(u)
      case '5':
        return this.setPaused(u, !u.paused)
      case '6':
        return this.say(u, await onboarding.linkText(this))
      case '0':
        return connect.presentNext(this, u)
      default:
        return this.showMenu(u)
    }
  }

  private async setPaused(u: User, paused: boolean) {
    this.db.run('UPDATE users SET paused = ? WHERE id = ?', paused ? 1 : 0, u.id)
    await this.say(u, paused
      ? "⏸ Paused. Members can't send you requests until you reply *!resume*."
      : '▶️ Resumed. Members can reach you again for what you opted in to.')
  }

  private async showProfile(u: User) {
    this.save(u, { state: 'profile' })
    const answers = JSON.parse(u.answers ?? '{}')
    await this.say(u, [
      '*👤 Your profile* (private, never shown in the group)',
      '',
      summarize(this.flows.onboard, answers),
      '',
      '*1.* Update my profile',
      '*0.* Back',
    ].join('\n'))
  }

  private async onProfileReply(u: User, lower: string) {
    if (lower === '1') return this.startUpdate(u)
    return this.showMenu(u)
  }

  private async startUpdate(u: User) {
    const answers = JSON.parse(u.answers ?? '{}')
    const order = Object.keys(answers).filter((k) => !k.endsWith('_other'))
    return this.toConfirm(u, { state: 'confirm', flow: 'onboard', answers, order, update: true })
  }

  // ---------- questionnaires ----------

  async startFlow(u: User, flow: FlowName) {
    const old = this.session(u)
    const resume = flow === 'onboard' && old.flow === 'onboard' && Object.keys(old.answers ?? {}).length > 0
    const s: Session = { state: 'q', flow, answers: resume ? old.answers : {}, order: resume ? old.order : [] }
    const intro = resume
      ? 'Continuing where you left off.\n\n'
      : flow === 'onboard'
        ? "Great! A few quick questions, about 2 minutes. Reply *back* to change the previous answer.\n\n"
        : 'Reply *back* to change the previous answer, or *menu* to cancel.\n\n'
    return this.askCurrent(u, s, intro)
  }

  private async askCurrent(u: User, s: Session, prefix = '') {
    const qs = this.flows[s.flow!]
    const q = nextQuestion(qs, s.answers!)
    if (!q) return this.toConfirm(u, s)
    s.state = 'q'
    this.save(u, s)
    const shown = qs.filter((x) => visible(x, s.answers!))
    await this.say(u, prefix + renderQuestion(q, `${shown.indexOf(q) + 1}/${shown.length}`))
  }

  private async onQuestionReply(u: User, s: Session, text: string, lower: string) {
    if (lower === 'restart') {
      return this.askCurrent(u, { ...s, answers: {}, order: [] }, 'Starting over.\n\n')
    }
    if (lower === 'back') {
      const id = s.order!.pop()
      if (!id) return this.askCurrent(u, s, 'This is the first question.\n\n')
      delete s.answers![id]
      delete s.answers![id + '_other']
      return this.askCurrent(u, s)
    }
    const q = nextQuestion(this.flows[s.flow!], s.answers!)
    if (!q) return this.toConfirm(u, s)
    if (GREETINGS.has(lower)) return this.askCurrent(u, s, "Let's pick up where you left off 👇\n\n")

    let r = parseAnswer(q, text)
    if (r.ok && q.id === 'exp_max' && Number(r.value) < Number(s.answers!.exp_min)) {
      r = { ok: false, error: `The maximum can't be lower than the minimum (${s.answers!.exp_min}).` }
    }
    if (!r.ok) return this.say(u, `${r.error}\n\n${renderQuestion(q)}`)

    s.answers![q.id] = r.value
    if (r.other) s.answers![q.id + '_other'] = r.other
    else delete s.answers![q.id + '_other']
    s.order!.push(q.id)
    return this.askCurrent(u, s)
  }

  private canCancel(s: Session) {
    return s.flow !== 'onboard' || !!s.update
  }

  private async toConfirm(u: User, s: Session) {
    prune(this.flows[s.flow!], s.answers!)
    s.state = 'confirm'
    this.save(u, s)
    await this.say(u, [
      `*Please check ${TITLES[s.flow!]}:*`,
      '',
      summarize(this.flows[s.flow!], s.answers!),
      '',
      '*1.* ✅ Confirm',
      '*2.* ✏️ Change an answer',
      ...(this.canCancel(s) ? ['*3.* ❌ Cancel'] : []),
    ].join('\n'))
  }

  private async onConfirmReply(u: User, s: Session, lower: string) {
    if (lower === '1' || lower === 'yes' || lower === 'confirm') {
      const { flow, answers, update } = s
      this.save(u, { state: 'menu' })
      if (flow === 'onboard') return onboarding.complete(this, u, answers!, !!update)
      if (flow === 'job') return jobs.publish(this, u, answers!)
      return connect.startRequest(this, u, flow as 'referral' | 'expert', answers!)
    }
    if (lower === '2') {
      s.state = 'edit'
      this.save(u, s)
      return this.say(u, [
        'Which one do you want to change?',
        '',
        summarize(this.flows[s.flow!], s.answers!, true),
        '',
        '_Reply with a number, or *0* to go back._',
      ].join('\n'))
    }
    if (lower === '3' && this.canCancel(s)) return this.showMenu(u, 'Cancelled.\n\n')
    return this.toConfirm(u, s)
  }

  private async onEditReply(u: User, s: Session, lower: string) {
    const shown = this.flows[s.flow!].filter((q) => visible(q, s.answers!))
    const q = /^\d+$/.test(lower) ? shown[Number(lower) - 1] : undefined
    if (!q) return this.toConfirm(u, s)
    delete s.answers![q.id]
    delete s.answers![q.id + '_other']
    s.order = s.order!.filter((id) => id !== q.id)
    return this.askCurrent(u, s)
  }

  // ---------- group events and timers ----------

  onJoinRequest(r: JoinRequest & { action: string }) {
    return onboarding.onJoinRequest(this, r)
  }

  onParticipants(action: string, people: { jid: string; pn?: string; lid?: string }[]) {
    return onboarding.onParticipants(this, action, people)
  }

  /** Runs every few minutes: catch missed join requests and expire old things. */
  async tick() {
    await onboarding.sync(this)
    await connect.expire(this)
    await jobs.expire(this)
  }
}
