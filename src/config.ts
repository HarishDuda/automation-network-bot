// Loads .env and the YAML files in config/.
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import type { Question } from './flow.js'
import type { FlowName, Settings, Texts } from './types.js'
import { digits } from './util.js'

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name])
  return process.env[name] && Number.isFinite(v) && v > 0 ? v : fallback
}

export function loadSettings(): Settings {
  const env = (k: string) => (process.env[k] ?? '').trim()
  return {
    groupJid: env('GROUP_JID'),
    inviteLink: env('GROUP_INVITE_LINK'),
    adminNumbers: env('ADMIN_NUMBERS').split(',').map(digits).filter(Boolean),
    pairingNumber: digits(env('PAIRING_NUMBER')),
    expireHours: num('EXPIRE_HOURS', 72),
    askExpireHours: num('ASK_EXPIRE_HOURS', 48),
    maxAsksPerWeek: num('MAX_ASKS_PER_WEEK', 3),
    maxRequestsPerDay: num('MAX_REQUESTS_PER_DAY', 3),
    jobMatchLimit: num('JOB_MATCH_LIMIT', 10),
    jobExpireDays: num('JOB_EXPIRE_DAYS', 30),
    contentCron: env('CONTENT_CRON') || '30 9 * * *',
    tz: env('TIMEZONE') || 'Asia/Kolkata',
  }
}

const read = (dir: string, file: string) => parse(readFileSync(path.join(dir, file), 'utf8'))

export function loadFlows(dir = 'config'): Record<FlowName, Question[]> {
  const onboard = read(dir, 'questions.yaml') as Question[]
  const extra = read(dir, 'connect_questions.yaml') as Record<'job' | 'referral' | 'expert', Question[]>
  const flows = { onboard, job: extra.job, referral: extra.referral, expert: extra.expert }
  for (const [name, qs] of Object.entries(flows)) {
    if (!Array.isArray(qs) || !qs.length) throw new Error(`config: no questions found for "${name}"`)
    for (const q of qs) {
      if (q.optionsFrom) {
        const src = onboard.find((x) => x.id === q.optionsFrom)
        if (!src?.options) throw new Error(`config: "${name}.${q.id}" uses optionsFrom "${q.optionsFrom}", which has no options`)
        q.options = src.options
      }
      if ((q.type === 'choice' || q.type === 'multi') && !q.options?.length) {
        throw new Error(`config: "${name}.${q.id}" needs options`)
      }
      // YAML reads 0 or 15 as numbers; the bot compares option values as text.
      q.options = q.options?.map((o) => ({ ...o, value: String(o.value) }))
    }
  }
  return flows
}

export function loadTexts(dir = 'config'): Texts {
  return read(dir, 'messages.yaml') as Texts
}
