// Offline tests: the bot talks to a fake WhatsApp, so no phone or network is needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bot } from '../src/bot.js'
import { loadFlows, loadTexts } from '../src/config.js'
import * as content from '../src/content.js'
import { Db } from '../src/db.js'
import type { JoinRequest, Settings, Transport } from '../src/types.js'
import { DAY, HOUR } from '../src/util.js'

const ADMIN = '919000000001'
const LINK = 'https://chat.whatsapp.com/TESTLINK'
const jid = (pn: string) => `${pn}@s.whatsapp.net`

class Fake implements Transport {
  sent: { jid: string; text: string }[] = []
  docs: { jid: string; fileName: string; data: string }[] = []
  group: { text: string; media?: string | null }[] = []
  approved: string[] = []
  rejected: string[] = []
  requests: JoinRequest[] = []
  async sendText(j: string, text: string) { this.sent.push({ jid: j, text }) }
  async sendDocument(j: string, data: Buffer, fileName: string) { this.docs.push({ jid: j, fileName, data: data.toString('utf8') }) }
  async postToGroup(text: string, media?: string | null) { this.group.push({ text, media }) }
  async approveJoin(j: string) { this.approved.push(j); this.requests = this.requests.filter((r) => r.jid !== j) }
  async rejectJoin(j: string) { this.rejected.push(j); this.requests = this.requests.filter((r) => r.jid !== j) }
  async listJoinRequests() { return this.requests }
  async inviteLink() { return LINK }
  async listGroups() { return [{ id: '120363000000000000@g.us', subject: 'Automation Network' }] }
  /** Everything sent to one number since the last call. */
  take(pn: string): string {
    const mine = this.sent.filter((m) => m.jid === jid(pn)).map((m) => m.text).join('\n---\n')
    this.sent = this.sent.filter((m) => m.jid !== jid(pn))
    return mine
  }
}

const settings = (over: Partial<Settings> = {}): Settings => ({
  groupJid: '120363000000000000@g.us', inviteLink: '', adminNumbers: [ADMIN], pairingNumber: '',
  expireHours: 72, askExpireHours: 48, maxAsksPerWeek: 3, maxRequestsPerDay: 3, jobMatchLimit: 10,
  jobExpireDays: 30, contentCron: '30 9 * * *', tz: 'Asia/Kolkata', ...over,
})

function setup(over: Partial<Settings> = {}) {
  const t = new Fake()
  const db = new Db(':memory:')
  const bot = new Bot(db, t, settings(over), loadTexts(), loadFlows())
  let clock = Date.UTC(2026, 10, 12, 4)
  bot.now = () => clock
  const say = async (pn: string, ...texts: string[]) => {
    for (const text of texts) await bot.onMessage({ jid: jid(pn), pn, text })
    return t.take(pn)
  }
  return { t, db, bot, say, advance: (ms: number) => { clock += ms } }
}

type Profile = { name: string; company: string; exp: string; techs: string; open: string; notice?: string; reach: string; location?: string }
/** exp: 1=0-1, 2=1-3, 3=3-5, 4=5-8, 5=8+ · open: 1 full-time, 2 freelance, 3 not now · reach: 1 jobs, 2 referrals, 3 mentoring, 4 none */
async function join(say: ReturnType<typeof setup>['say'], pn: string, p: Profile) {
  return say(pn, 'Hi', '1', p.name, p.location ?? 'Bangalore', p.company, 'RPA Developer', p.exp, p.techs, '1',
    p.open, ...(p.notice ? [p.notice] : []), 'skip', p.reach, '1')
}

const A = '919111111111', B = '919222222222', C = '919333333333', D = '919444444444'

test('joining: welcome menu, bad answers are asked again, notice period only when relevant', async () => {
  const { say, db, t } = setup()
  const hi = await say(A, 'Hi')
  assert.match(hi, /Welcome to Automation Network/)
  assert.match(hi, /\*1\.\* Join the community/)

  assert.match(await say(A, '1'), /full name/)
  await say(A, 'Asha Rao', 'Bangalore', 'ABC Corp', 'RPA Lead')
  const bad = await say(A, 'lots')
  assert.match(bad, /experience/i, 'question is repeated after a bad answer')
  assert.ok(!/Technologies|technologies do you/.test(bad.split('\n')[0]))
  assert.match(await say(A, '3'), /technolog/i)
  assert.match(await say(A, '99'), /technolog/i, 'out-of-range option is rejected')
  await say(A, '1, 7', '1')
  // Not open to work → notice period is skipped, LinkedIn comes next.
  const afterOpen = await say(A, '3')
  assert.match(afterOpen, /linkedin/i)
  assert.doesNotMatch(afterOpen, /notice/i)
  assert.match(await say(A, 'not a link'), /linkedin/i, 'bad URL is rejected')
  await say(A, 'https://www.linkedin.com/in/asha', '2')
  const done = await say(A, '1')
  assert.match(done, new RegExp(LINK), 'invite link is sent after confirming')

  const u = db.get('SELECT * FROM users WHERE pn = ?', A)
  assert.equal(u.status, 'completed')
  assert.equal(u.name, 'Asha Rao')
  assert.equal(u.techs, ',uipath,python,')
  assert.equal(u.notice, null)
  assert.equal(t.group.length, 0, 'nothing is posted in the group')
})

test('joining: someone open to work is asked for the notice period; back works', async () => {
  const { say, db } = setup()
  await say(B, 'Hi', '1', 'Bala K', 'Chennai', 'XYZ Ltd', 'Developer', '3', '1', '1')
  assert.match(await say(B, '1'), /notice/i)
  assert.match(await say(B, 'back'), /open to/i, 'back returns to the previous question')
  await say(B, '1', '3', 'skip', '1', '1')
  const u = db.get('SELECT * FROM users WHERE pn = ?', B)
  assert.equal(u.status, 'completed')
  assert.equal(u.notice, 30)
})

test('joining: answers survive a restart of the bot', async () => {
  const { say, db, t, bot } = setup()
  await say(A, 'Hi', '1', 'Asha Rao', 'Bangalore')
  const bot2 = new Bot(db, t, bot.cfg, bot.texts, bot.flows)
  await bot2.onMessage({ jid: jid(A), pn: A, text: 'Hi' })
  const again = t.take(A)
  assert.match(again, /pick up where you left off/)
  assert.match(again, /working currently[^]*3\/10/, 'continues with the third question')
})

test('group door: finished members are approved, others are nudged and rejected after 72h', async () => {
  const { say, bot, t, advance } = setup()
  // C taps the link without answering.
  t.requests.push({ jid: jid(C), pn: C })
  await bot.onJoinRequest({ jid: jid(C), pn: C, action: 'created' })
  assert.match(t.take(C), /Reply \*Hi\* to start/)
  assert.deepEqual(t.approved, [])
  await bot.tick()
  assert.equal(t.take(C), '', 'the nudge is sent only once')

  // D taps the link, then answers the questions → approved on completion.
  t.requests.push({ jid: jid(D), pn: D })
  await bot.onJoinRequest({ jid: jid(D), pn: D, action: 'created' })
  const done = await join(say, D, { name: 'Dev D', company: 'Delta', exp: '2', techs: '1', open: '3', reach: '4' })
  assert.deepEqual(t.approved, [jid(D)])
  assert.match(done, /approved|in the group|You're in/i)

  // A answers first, then taps the link → approved at once.
  await join(say, A, { name: 'Asha Rao', company: 'ABC Corp', exp: '3', techs: '1', open: '3', reach: '2' })
  await bot.onJoinRequest({ jid: jid(A), pn: A, action: 'created' })
  assert.deepEqual(t.approved, [jid(D), jid(A)])

  advance(73 * HOUR)
  await bot.tick()
  assert.deepEqual(t.rejected, [jid(C)])
})

test('jobs: matching, anonymous card, double opt-in, then contacts are exchanged', async () => {
  const { say, t, db } = setup()
  await join(say, A, { name: 'Asha Rao', company: 'ABC Corp', exp: '4', techs: '1', open: '3', reach: '2' })
  await join(say, B, { name: 'Bala K', company: 'XYZ Ltd', exp: '3', techs: '1,7', open: '1', notice: '2', reach: '1' }) // 3-5 yrs, 15 days
  await join(say, C, { name: 'Chitra M', company: 'LMN', exp: '3', techs: '1', open: '1', notice: '5', reach: '1' })   // 90 days notice
  await join(say, D, { name: 'Dev D', company: 'Delta', exp: '3', techs: '4', open: '1', notice: '2', reach: '1' })    // Blue Prism only
  t.sent = []

  // A posts a backfill: UiPath, 3–6 yrs, notice up to 30 days.
  const posted = await say(A, 'menu', '1', '2', 'ABC Corp', 'RPA Developer', '1', '1', '3', '6', 'Bangalore', '3', 'skip', '1')
  assert.match(posted, /Job #1 is live/)
  assert.match(posted, /1 matching member/)

  const offer = t.take(B)
  assert.match(offer, /RPA Developer @ ABC Corp/)
  assert.doesNotMatch(offer, /Asha|9111111111/, 'the poster is not revealed')
  assert.equal(t.take(C), '', '90 days notice does not match')
  assert.equal(t.take(D), '', 'different technology does not match')

  await say(B, '1')
  const interest = t.take(A)
  assert.match(interest, /Member #M\d+/)
  assert.match(interest, /UiPath/)
  assert.doesNotMatch(interest, /Bala|XYZ|9222222222/, 'the candidate stays anonymous until the poster connects')
  const askId = interest.match(/connect (\d+)/)![1]

  const toA = await say(A, `connect ${askId}`)
  const toB = t.take(B)
  assert.match(toA, /Bala K/)
  assert.match(toA, new RegExp(`wa.me/${B}`))
  assert.match(toB, /Asha Rao/)
  assert.match(toB, new RegExp(`wa.me/${A}`))
  assert.equal(db.get('SELECT COUNT(*) n FROM connections').n, 1)

  // C can still find it under Browse and apply on her own.
  const browse = await say(C, 'menu', '1', '1')
  assert.match(browse, /RPA Developer @ ABC Corp/)
  await say(C, '1', '1')
  assert.match(t.take(A), /Member #M\d+[^]*notice 90 days/)

  assert.match(await say(A, 'close 1'), /closed/)
  assert.match(await say(D, 'menu', '1', '1'), /no open jobs/i)
  assert.equal(t.group.length, 0, 'nothing about jobs or members goes to the group')
})

test('referral: asks members at that company anonymously; paused members get nothing', async () => {
  const { say, t } = setup()
  await join(say, A, { name: 'Asha Rao', company: 'ABC Corp Pvt Ltd', exp: '4', techs: '1', open: '3', reach: '2' })
  await join(say, B, { name: 'Bala K', company: 'XYZ Ltd', exp: '3', techs: '1', open: '1', notice: '2', reach: '1' })
  await join(say, C, { name: 'Chitra M', company: 'LMN', exp: '2', techs: '1', open: '1', notice: '2', reach: '1' })
  t.sent = []

  await say(A, '!pause')
  assert.match(await say(B, 'menu', '2', 'abc corp', 'Senior RPA dev role', '1'), /couldn't find a member/)
  assert.equal(t.take(A), '', 'paused member is not contacted')

  await say(A, '!resume')
  assert.match(await say(C, 'menu', '2', 'ABC Corp', 'skip', '1'), /Sent privately to 1 member/)
  const ask = t.take(A)
  assert.match(ask, /Referral request/)
  assert.match(ask, /Member #M\d+/)
  assert.doesNotMatch(ask, /Chitra|LMN|9333333333/)

  assert.match(await say(A, '1'), /Chitra M[^]*wa\.me\/919333333333/)
  assert.match(t.take(C), /Asha Rao[^]*wa\.me\/919111111111/)
})

test('expert: first yes is connected; a "no" reveals nothing', async () => {
  const { say, t } = setup()
  await join(say, A, { name: 'Asha Rao', company: 'ABC', exp: '5', techs: '1', open: '3', reach: '3' })
  await join(say, B, { name: 'Bala K', company: 'XYZ', exp: '4', techs: '1', open: '3', reach: '3' })
  await join(say, C, { name: 'Chitra M', company: 'LMN', exp: '1', techs: '7', open: '3', reach: '4' })
  t.sent = []
  assert.match(await say(C, 'menu', '3', '1', 'How do I handle REFramework retries?', '1'), /Sent privately to 2 members/)
  assert.match(t.take(A), /needs help with UiPath[^]*REFramework/)
  await say(A, '2')
  assert.equal(t.take(C), '', 'requester hears nothing about a no')
  await say(B, '1')
  assert.match(t.take(C), /Bala K/)
  assert.doesNotMatch(t.take(A), /Chitra/)
})

test('limits: at most 3 requests a week per member, 3 requests a day per requester', async () => {
  const { say, t, advance } = setup()
  await join(say, A, { name: 'Asha Rao', company: 'ABC', exp: '5', techs: '1', open: '3', reach: '3' })
  const askers = ['919500000001', '919500000002', '919500000003', '919500000004']
  for (const [i, pn] of askers.entries()) {
    await join(say, pn, { name: `Asker ${i}`, company: `Co${i}`, exp: '1', techs: '7', open: '3', reach: '4' })
  }
  t.sent = []
  for (const pn of askers.slice(0, 3)) {
    assert.match(await say(pn, 'menu', '3', '1', 'Need help', '1'), /Sent privately to 1 member/)
  }
  assert.match(await say(askers[3], 'menu', '3', '1', 'Need help', '1'), /couldn't find an available member/, '4th request this week is held back')
  assert.equal((t.take(A).match(/needs help with/g) ?? []).length, 1, 'only one request is shown at a time')

  // The same requester cannot spam: after 3 requests in a day the menu refuses.
  await say(askers[0], 'menu', '3', '2', 'q2', '1')
  await say(askers[0], 'menu', '3', '3', 'q3', '1')
  assert.match(await say(askers[0], 'menu', '3'), /limit of 3 requests/)
  advance(DAY + HOUR)
  assert.doesNotMatch(await say(askers[0], 'menu', '3'), /limit of 3 requests/)
})

test('requests expire after 48h and the requester is told', async () => {
  const { say, t, bot, advance } = setup()
  await join(say, A, { name: 'Asha Rao', company: 'ABC', exp: '5', techs: '1', open: '3', reach: '3' })
  await join(say, B, { name: 'Bala K', company: 'XYZ', exp: '1', techs: '7', open: '3', reach: '4' })
  await say(B, 'menu', '3', '1', 'Need help', '1')
  t.sent = []
  advance(49 * HOUR)
  await bot.tick()
  assert.match(t.take(B), /Nobody was available/)
  assert.match(await say(A, '1'), /no longer open/)
})

test('daily post: admins queue posts, one goes out per run, nothing when empty', async () => {
  const { say, t, bot } = setup()
  assert.equal(await content.postNext(bot), false)
  assert.match(await say(ADMIN, '!queue UiPath released Agent Builder GA'), /Queued. 1 post/)
  assert.match(await say(ADMIN, '!queue Second insight'), /2 posts/)
  assert.match(await say(ADMIN, '!queue list'), /\*1\.\* UiPath released[^]*\*2\.\* Second insight/)
  assert.equal(await content.postNext(bot), true)
  assert.deepEqual(t.group.map((g) => g.text), ['UiPath released Agent Builder GA'])
  assert.match(await say(ADMIN, '!postnow'), /Posted/)
  assert.equal(t.group.length, 2)
  assert.equal(await content.postNext(bot), false)
  assert.equal(t.group.length, 2)
  // Non-admins cannot queue.
  await join(say, A, { name: 'Asha Rao', company: 'ABC', exp: '5', techs: '1', open: '3', reach: '3' })
  assert.match(await say(A, '!queue spam'), /don't know that command/)
})

test('admin: stats, export, find, block', async () => {
  const { say, t, bot } = setup()
  await join(say, A, { name: 'Asha "AR" Rao', company: 'ABC, Corp', exp: '4', techs: '1,7', open: '3', reach: '2' })
  await join(say, B, { name: 'Bala K', company: 'XYZ', exp: '3', techs: '1', open: '1', notice: '3', reach: '1' })
  const stats = await say(ADMIN, '!stats')
  assert.match(stats, /Profiles completed: 2/)
  assert.match(stats, /Open to work: 1/)
  assert.match(stats, /UiPath: 2/)

  assert.match(await say(ADMIN, '!export'), /Sent 2 profiles/)
  const csv = t.docs[0].data
  assert.match(csv, /"Asha ""AR"" Rao"/)
  assert.match(csv, /"ABC, Corp"/)
  assert.match(csv, /"\+919222222222"/)
  assert.equal(csv.trim().split('\r\n').length, 3)

  assert.match(await say(ADMIN, '!find python'), /1 member with "python"[^]*Asha/)
  assert.match(await say(ADMIN, '!opentowork 30'), /Bala K[^]*30d notice/)
  assert.match(await say(ADMIN, '!groups'), /120363000000000000@g\.us/)

  assert.match(await say(ADMIN, `!block ${B}`), /Blocked/)
  assert.equal(await say(B, 'Hi'), '', 'blocked numbers get no reply')
  await bot.onJoinRequest({ jid: jid(B), pn: B, action: 'created' })
  assert.deepEqual(t.rejected, [jid(B)])
  assert.match(await say(A, '!stats'), /don't know that command/, 'members cannot use admin commands')
})

test('identity: a member who writes from a hidden-number (LID) chat is still recognised', async () => {
  const { say, bot, t } = setup()
  await join(say, A, { name: 'Asha Rao', company: 'ABC', exp: '5', techs: '1', open: '3', reach: '3' })
  await bot.onMessage({ jid: '123456789@lid', lid: '123456789@lid', pn: A, text: 'menu' })
  assert.match(t.sent.at(-1)!.text, /My profile/)
  await bot.onJoinRequest({ jid: '123456789@lid', action: 'created' })
  assert.deepEqual(t.approved, ['123456789@lid'])
})
