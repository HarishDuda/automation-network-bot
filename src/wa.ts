// The WhatsApp side (Baileys). Everything else talks to it through the Transport interface.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, isJidGroup, isLidUser, isPnUser,
  jidNormalizedUser, makeWASocket, useMultiFileAuthState, type WAMessage, type WASocket,
} from 'baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import type { Incoming, JoinRequest, Settings, Transport } from './types.js'
import { digits } from './util.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MAX_AGE_MS = 6 * 60 * 60 * 1000

type Person = { jid: string; pn?: string; lid?: string }
export type Handlers = {
  message(m: Incoming): Promise<unknown>
  joinRequest(r: JoinRequest & { action: string }): Promise<unknown>
  participants(action: string, people: Person[]): Promise<unknown>
  ready(): Promise<unknown>
}

export class Wa implements Transport {
  private sock!: WASocket
  private online = false
  private outbox: Promise<unknown> = Promise.resolve()
  private inbox: Promise<unknown> = Promise.resolve()
  private log = pino({ level: process.env.LOG_LEVEL ?? 'warn' })
  handlers!: Handlers

  constructor(private cfg: Settings, private authDir = 'auth', private mediaDir = path.join('data', 'media')) {}

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))
    const sock = makeWASocket({
      auth: state,
      version,
      logger: this.log.child({ module: 'baileys' }, { level: 'error' }) as any,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })
    this.sock = sock
    let askedForCode = false

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        if (this.cfg.pairingNumber && !state.creds.registered) {
          if (askedForCode) return
          askedForCode = true
          const code = await sock.requestPairingCode(this.cfg.pairingNumber)
          console.log(`\nPairing code: ${code}\nOn the bot's phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.\n`)
        } else {
          console.log("\nScan this QR code with the bot's WhatsApp (Linked devices → Link a device):\n")
          qrcode.generate(qr, { small: true })
        }
      }
      if (connection === 'open') {
        this.online = true
        console.log('✅ Connected to WhatsApp.')
        this.enqueueIn(() => this.handlers.ready())
      }
      if (connection === 'close') {
        this.online = false
        const code = (lastDisconnect?.error as any)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          console.error('Logged out of WhatsApp. Delete the "auth" folder and start again to link the number.')
          process.exit(1)
        }
        console.log(`Connection closed (${code ?? 'unknown'}). Reconnecting…`)
        setTimeout(() => this.start().catch((e) => this.log.error(e)), 3000)
      }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) this.enqueueIn(() => this.receive(msg))
    })

    sock.ev.on('group.join-request', (ev) => {
      if (ev.id !== this.cfg.groupJid) return
      this.enqueueIn(async () => {
        const jid = jidNormalizedUser(ev.participant)
        const pn = digitsOf(ev.participantPn) ?? (await this.pnOf(jid))
        await this.handlers.joinRequest({ jid, pn, action: ev.action })
      })
    })

    sock.ev.on('group-participants.update', (ev) => {
      if (ev.id !== this.cfg.groupJid) return
      this.enqueueIn(async () => {
        const people: Person[] = []
        for (const p of ev.participants) {
          const jid = jidNormalizedUser(p.id)
          const lid = isLidUser(jid) ? jid : p.lid ? jidNormalizedUser(p.lid) : undefined
          people.push({ jid, lid, pn: digitsOf(p.phoneNumber) ?? (await this.pnOf(jid)) })
        }
        await this.handlers.participants(ev.action, people)
      })
    })
  }

  /** Handle incoming things one at a time so two messages never race on the same session. */
  private enqueueIn(job: () => Promise<unknown>) {
    this.inbox = this.inbox.then(job).catch((e) => this.log.error(e, 'handler failed'))
  }

  private async pnOf(jid: string): Promise<string | undefined> {
    if (isPnUser(jid)) return digitsOf(jid)
    if (!isLidUser(jid)) return undefined
    try {
      return digitsOf(await this.sock.signalRepository.lidMapping.getPNForLID(jid))
    } catch {
      return undefined
    }
  }

  private async receive(msg: WAMessage) {
    const remote = msg.key.remoteJid
    if (!remote || msg.key.fromMe || !msg.message) return
    if (isJidGroup(remote) || !(isPnUser(remote) || isLidUser(remote))) return // private chats only
    const sentAt = Number(msg.messageTimestamp ?? 0) * 1000
    if (sentAt && Date.now() - sentAt > MAX_AGE_MS) return

    const c = msg.message.ephemeralMessage?.message ?? msg.message
    const text = (c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? '').trim()
    if (!text) return

    const jid = jidNormalizedUser(remote)
    const alt = msg.key.remoteJidAlt ? jidNormalizedUser(msg.key.remoteJidAlt) : undefined
    const lid = isLidUser(jid) ? jid : alt && isLidUser(alt) ? alt : undefined
    const pn = digitsOf(isPnUser(jid) ? jid : alt && isPnUser(alt) ? alt : undefined) ?? (await this.pnOf(jid))

    let mediaPath: string | undefined
    if (c.imageMessage && /^!queue\b/i.test(text) && pn && this.cfg.adminNumbers.includes(pn)) {
      try {
        const data = await downloadMediaMessage(msg, 'buffer', {})
        mkdirSync(this.mediaDir, { recursive: true })
        mediaPath = path.join(this.mediaDir, `${msg.key.id}.jpg`)
        writeFileSync(mediaPath, data)
      } catch (e) {
        this.log.warn(e, 'could not download image')
      }
    }
    await this.sock.readMessages([msg.key]).catch(() => {})
    await this.handlers.message({ jid, pn, lid, text, mediaPath })
  }

  /** All outgoing messages go through one queue with a human-like pause, to stay under WhatsApp's radar. */
  private send(jid: string, content: Parameters<WASocket['sendMessage']>[1], typing = true): Promise<void> {
    const run = async () => {
      for (let i = 0; i < 60 && !this.online; i++) await sleep(1000)
      if (typing) await this.sock.sendPresenceUpdate('composing', jid).catch(() => {})
      await sleep(1000 + Math.random() * 2000)
      await this.sock.sendMessage(jid, content)
      if (typing) await this.sock.sendPresenceUpdate('paused', jid).catch(() => {})
    }
    const p = this.outbox.then(run)
    this.outbox = p.catch(() => {})
    return p
  }

  sendText(jid: string, text: string) {
    return this.send(jid, { text })
  }

  sendDocument(jid: string, data: Buffer, fileName: string, mimetype: string) {
    return this.send(jid, { document: data, fileName, mimetype })
  }

  postToGroup(text: string, mediaPath?: string | null) {
    if (!this.cfg.groupJid) throw new Error('GROUP_JID is not set')
    const content = mediaPath ? { image: readFileSync(mediaPath), caption: text } : { text }
    return this.send(this.cfg.groupJid, content, false)
  }

  async approveJoin(jid: string) {
    await this.sock.groupRequestParticipantsUpdate(this.cfg.groupJid, [jid], 'approve')
  }

  async rejectJoin(jid: string) {
    await this.sock.groupRequestParticipantsUpdate(this.cfg.groupJid, [jid], 'reject')
  }

  async listJoinRequests(): Promise<JoinRequest[]> {
    const rows = await this.sock.groupRequestParticipantsList(this.cfg.groupJid)
    const out: JoinRequest[] = []
    for (const r of rows) {
      if (!r.jid) continue
      const jid = jidNormalizedUser(r.jid)
      out.push({ jid, pn: digitsOf(r.phone_number) ?? (await this.pnOf(jid)) })
    }
    return out
  }

  async inviteLink(): Promise<string> {
    if (this.cfg.inviteLink) return this.cfg.inviteLink
    const code = await this.sock.groupInviteCode(this.cfg.groupJid)
    if (!code) throw new Error('no invite code')
    return `https://chat.whatsapp.com/${code}`
  }

  async listGroups() {
    const groups = await this.sock.groupFetchAllParticipating()
    return Object.values(groups).map((g) => ({ id: g.id, subject: g.subject }))
  }
}

function digitsOf(jid?: string | null): string | undefined {
  if (!jid) return undefined
  const d = digits(jid.split('@')[0].split(':')[0])
  return d || undefined
}
