// ---------------------------------------------------------------------------
// imapGetCode.ts  — BOILERPLATE for Phase 2: automated OTP / confirmation-code
// retrieval from an account's email box using imapflow + mailparser.
//
// This module is intentionally self-contained and NOT yet wired into IPC.
// It gives you a working, typed starting point to build the "Get Code"
// feature on top of. Import it from an ipcMain handler when you're ready.
// ---------------------------------------------------------------------------
import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import { simpleParser } from 'mailparser'

export interface MailAccount {
  email: string
  password: string
  /** e.g. 'imap.gmail.com' — if omitted we try to infer from the domain. */
  host?: string
  port?: number
  secure?: boolean
}

export interface GetCodeOptions {
  /** How many of the most recent messages to scan. */
  scanCount?: number
  /** Regex used to extract the code. Default matches 4–8 digit codes. */
  codeRegex?: RegExp
  /** Only consider mail from these senders (substring match), e.g. facebook. */
  fromContains?: string[]
  /** Search window in minutes (ignore mail older than this). */
  withinMinutes?: number
}

export interface GetCodeResult {
  code: string | null
  subject?: string
  from?: string
  date?: Date
  matchedMessage?: boolean
}

const DEFAULT_CODE_REGEX = /\b(\d{4,8})\b/
const DEFAULT_FROM = ['facebook', 'fb', 'meta']

/** Best-effort IMAP host inference from common providers. */
function inferHost(email: string): { host: string; port: number; secure: boolean } {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    'gmail.com': 'imap.gmail.com',
    'googlemail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com',
    'hotmail.com': 'outlook.office365.com',
    'live.com': 'outlook.office365.com',
    'yahoo.com': 'imap.mail.yahoo.com',
    'aol.com': 'imap.aol.com'
  }
  const host = map[domain] ?? `imap.${domain}`
  return { host, port: 993, secure: true }
}

/**
 * Connect to a mailbox, scan the most recent messages and extract the first
 * numeric code found (optionally restricted to Facebook senders).
 *
 * Usage (Phase 2):
 *   const res = await getCodeFromMailbox(
 *     { email, password, host, port },
 *     { fromContains: ['facebook'] }
 *   )
 */
export async function getCodeFromMailbox(
  account: MailAccount,
  options: GetCodeOptions = {}
): Promise<GetCodeResult> {
  const inferred = inferHost(account.email)
  const opts: ImapFlowOptions = {
    host: account.host ?? inferred.host,
    port: account.port ?? inferred.port,
    secure: account.secure ?? inferred.secure,
    auth: { user: account.email, pass: account.password },
    logger: false
  }

  const scanCount = options.scanCount ?? 15
  const codeRegex = options.codeRegex ?? DEFAULT_CODE_REGEX
  const fromContains = (options.fromContains ?? DEFAULT_FROM).map((s) => s.toLowerCase())
  const cutoff =
    options.withinMinutes != null
      ? new Date(Date.now() - options.withinMinutes * 60_000)
      : null

  const client = new ImapFlow(opts)
  await client.connect()

  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const status = await client.status('INBOX', { messages: true })
      const total = status.messages ?? 0
      if (total === 0) return { code: null }

      const start = Math.max(1, total - scanCount + 1)
      const range = `${start}:*`

      // Walk newest-first.
      const messages: {
        subject?: string
        from?: string
        date?: Date
        text: string
      }[] = []

      for await (const msg of client.fetch(range, { source: true, envelope: true })) {
        if (!msg.source) continue
        const parsed = await simpleParser(msg.source)
        messages.push({
          subject: parsed.subject,
          from: parsed.from?.text,
          date: parsed.date,
          text: `${parsed.subject ?? ''}\n${parsed.text ?? ''}`
        })
      }
      messages.reverse() // newest first

      for (const m of messages) {
        if (cutoff && m.date && m.date < cutoff) continue
        if (fromContains.length && m.from) {
          const fromLc = m.from.toLowerCase()
          if (!fromContains.some((f) => fromLc.includes(f))) continue
        }
        const match = m.text.match(codeRegex)
        if (match) {
          return {
            code: match[1],
            subject: m.subject,
            from: m.from,
            date: m.date,
            matchedMessage: true
          }
        }
      }

      return { code: null, matchedMessage: false }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => void 0)
  }
}
