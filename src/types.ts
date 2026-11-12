import type { Answers } from './flow.js'

export type Settings = {
  groupJid: string
  inviteLink: string
  adminNumbers: string[]
  pairingNumber: string
  expireHours: number
  askExpireHours: number
  maxAsksPerWeek: number
  maxRequestsPerDay: number
  jobMatchLimit: number
  jobExpireDays: number
  contentCron: string
  tz: string
}

export type Texts = { communityName: string; welcome: string; about: string; adminContact: string; nudge: string }

export type FlowName = 'onboard' | 'job' | 'referral' | 'expert'

export type Session = {
  state: 'idle' | 'menu' | 'q' | 'confirm' | 'edit' | 'ask' | 'jobs' | 'profile' | 'browse' | 'jobview'
  flow?: FlowName
  answers?: Answers
  order?: string[]
  update?: boolean
  askId?: number
  ids?: number[]
  jobId?: number
}

export type User = {
  id: number
  jid: string
  pn: string | null
  lid: string | null
  status: 'new' | 'completed' | 'blocked'
  in_group: number
  paused: number
  name: string | null
  location: string | null
  company: string | null
  company_norm: string | null
  role: string | null
  exp: string | null
  exp_min: number | null
  exp_max: number | null
  techs: string | null
  tech_other: string | null
  projects: string | null
  open_to_work: string | null
  notice: number | null
  linkedin: string | null
  reach: string | null
  answers: string | null
  session: string | null
  created_at: number
  completed_at: number | null
}

export type Job = {
  id: number
  poster: number
  company: string
  role: string
  type: string
  techs: string
  tech_other: string | null
  exp_min: number
  exp_max: number
  location: string
  max_notice: number
  details: string | null
  status: 'open' | 'closed'
  created_at: number
}

export type Ask = {
  id: number
  kind: 'job' | 'referral' | 'expert'
  ref_id: number
  from_user: number
  to_user: number
  status: 'queued' | 'sent' | 'yes' | 'no' | 'connected' | 'expired'
  created_at: number
}

export type Incoming = { jid: string; pn?: string; lid?: string; text: string; mediaPath?: string }

export type JoinRequest = { jid: string; pn?: string }

/** Everything the bot needs from WhatsApp. The real one is in wa.ts; tests use a fake. */
export interface Transport {
  sendText(jid: string, text: string): Promise<void>
  sendDocument(jid: string, data: Buffer, fileName: string, mimetype: string): Promise<void>
  postToGroup(text: string, mediaPath?: string | null): Promise<void>
  approveJoin(jid: string): Promise<void>
  rejectJoin(jid: string): Promise<void>
  listJoinRequests(): Promise<JoinRequest[]>
  inviteLink(): Promise<string>
  listGroups(): Promise<{ id: string; subject: string }[]>
}
