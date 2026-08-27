// ---------------------------------------------------------------------------
// imapWorker.ts  — multi-provider IMAP fetcher for Facebook confirmation codes.
// Uses imapflow to connect + mailparser to read message bodies.
//
// Robustness features:
//   * Scans INBOX first, then Spam/Junk/Bulk/Trash folders.
//   * Extracts codes from several Facebook formats (6/8-digit, FB-/c- prefixes,
//     keyword-led).
//   * Reads both plain-text and HTML parts.
//   * TLS `rejectUnauthorized: false` to survive strict-cert providers.
//   * Detailed, actionable error diagnostics (auth / timeout / no-code).
// ---------------------------------------------------------------------------
import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import { simpleParser } from 'mailparser'

export interface ImapServer {
  host: string
  port: number
  secure: boolean
}

export interface FetchOtpOptions {
  /** Explicit IMAP server override (e.g. from account.mail_server). */
  mailServer?: string
  /** How many recent messages to scan per folder. Default 25. */
  scanCount?: number
  /** Connection/operation timeout in ms. Default 20000. */
  timeoutMs?: number
  /** Only consider mail newer than this many minutes. Default 1440 (24h). */
  withinMinutes?: number
}

/** Machine-readable failure category for the UI to react to. */
export type OtpErrorCode =
  | 'AUTH_FAILED'
  | 'TIMEOUT'
  | 'CONNECTION'
  | 'NO_CODE'
  | 'EMPTY'
  | 'INPUT'

export interface FetchOtpResult {
  success: boolean
  code?: string
  subject?: string
  from?: string
  date?: string
  /** Folder the code was found in (INBOX / Spam / …). */
  folder?: string
  error?: string
  errorCode?: OtpErrorCode
}

// ---------------------------------------------------------------------------
// OTP extraction
// ---------------------------------------------------------------------------

/**
 * Facebook code patterns, most-specific first. Each capturing group 1 is the
 * numeric code. Ordered so prefixed / keyword-led codes win over a bare number.
 */
const OTP_PATTERNS: RegExp[] = [
  /FB-(\d{5,8})/i, // "FB-12345"
  /\bc-(\d{5,8})/i, // "c-12345"
  /(?:code|mã|m[ãa] x[áa]c nh[ậa]n|verification|pin|c[ôo]ng c[ụu])[^\d]{0,20}(\d{5,8})/i,
  /\b(\d{8})\b/, // 8-digit standalone
  /\b(\d{6})\b/ // 6-digit standalone
]

/** Extract the first Facebook-style code from text, or null. */
export function extractOtp(text: string): string | null {
  if (!text) return null
  for (const re of OTP_PATTERNS) {
    const m = text.match(re)
    if (m && m[1]) return m[1]
  }
  return null
}

// ---------------------------------------------------------------------------
// Facebook message identification
// ---------------------------------------------------------------------------

const FB_FROM_HINTS = [
  'facebookmail.com',
  'facebook.com',
  'meta.com',
  'metamail.com',
  'facebook'
]
const FB_SUBJECT_HINTS = [
  'facebook',
  'code',
  'security',
  'xác nhận', // "confirmation"
  'công cụ', // "tool/utility"
  'mã', // "code"
  'confirmation',
  'verify',
  'verification',
  'log in',
  'login',
  'pin'
]

function looksLikeFacebook(from: string, subject: string): boolean {
  const f = from.toLowerCase()
  const s = subject.toLowerCase()
  if (FB_FROM_HINTS.some((h) => f.includes(h))) return true
  if (FB_SUBJECT_HINTS.some((h) => s.includes(h))) return true
  return false
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an IMAP server for an email address.
 * Explicit `mailServer` wins; then known providers; then a `mail.{domain}`
 * fallback.
 */
export function resolveImapServer(email: string, mailServer?: string): ImapServer {
  // Explicit override — accept "host" or "host:port".
  if (mailServer && mailServer.trim()) {
    const raw = mailServer.trim()
    const [host, portStr] = raw.split(':')
    const port = portStr ? parseInt(portStr, 10) : 993
    return { host, port: Number.isFinite(port) ? port : 993, secure: port !== 143 }
  }

  const domain = (email.split('@')[1] ?? '').toLowerCase()

  const map: Record<string, ImapServer> = {
    'yandex.com': { host: 'imap.yandex.com', port: 993, secure: true },
    'yandex.ru': { host: 'imap.yandex.com', port: 993, secure: true },
    'yandex.by': { host: 'imap.yandex.com', port: 993, secure: true },
    'zoho.com': { host: 'imap.zoho.com', port: 993, secure: true },
    'zohomail.com': { host: 'imap.zoho.com', port: 993, secure: true },
    'mailfence.com': { host: 'imap.mailfence.com', port: 993, secure: true },
    'outlook.com': { host: 'outlook.office365.com', port: 993, secure: true },
    'hotmail.com': { host: 'outlook.office365.com', port: 993, secure: true },
    'live.com': { host: 'outlook.office365.com', port: 993, secure: true },
    'gmail.com': { host: 'imap.gmail.com', port: 993, secure: true },
    'googlemail.com': { host: 'imap.gmail.com', port: 993, secure: true },
    'yahoo.com': { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    'aol.com': { host: 'imap.aol.com', port: 993, secure: true }
  }

  if (map[domain]) return map[domain]

  // Fallback: mail.{domain}:993 TLS.
  return { host: `mail.${domain}`, port: 993, secure: true }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Turn a raw connection/auth error into a friendly, actionable message. */
function classifyError(err: unknown): { code: OtpErrorCode; message: string } {
  const e = (err ?? {}) as Record<string, unknown>
  const raw = err instanceof Error ? err.message : String(err)

  // imapflow attaches structured hints; the message is often just "Command failed".
  const authFlag = e.authenticationFailed === true
  const serverCode = String(e.serverResponseCode ?? '').toUpperCase()
  const responseText = String(e.responseText ?? '')
  const nodeCode = String(e.code ?? '').toUpperCase()

  // Fold every available signal into one lowercase haystack.
  const hay = [raw, responseText, serverCode, nodeCode].join(' ').toLowerCase()

  if (
    authFlag ||
    serverCode === 'AUTHENTICATIONFAILED' ||
    hay.includes('invalid credentials') ||
    hay.includes('authentication failed') ||
    hay.includes('authenticationfailed') ||
    hay.includes('login failed') ||
    hay.includes('logging in') ||
    hay.includes('auth') ||
    hay.includes('password') ||
    // Generic "Command failed" with no network hint almost always = bad login.
    (raw.toLowerCase().includes('command failed') &&
      !hay.match(/enotfound|econnrefused|econnreset|etimedout|timed out|certificate/))
  ) {
    return {
      code: 'AUTH_FAILED',
      message:
        'Authentication Failed: Invalid Mail Password or an App Password is required by the provider (e.g. enable IMAP + App Password in Yandex/Zoho settings).'
    }
  }
  if (
    hay.includes('timed out') ||
    hay.includes('timeout') ||
    nodeCode === 'ETIMEDOUT'
  ) {
    return {
      code: 'TIMEOUT',
      message: 'Connection Timeout: Could not connect to the IMAP server within 20 seconds.'
    }
  }
  if (
    hay.includes('enotfound') ||
    hay.includes('econnrefused') ||
    hay.includes('econnreset') ||
    hay.includes('getaddrinfo') ||
    hay.includes('certificate') ||
    hay.includes('tls') ||
    hay.includes('socket')
  ) {
    return {
      code: 'CONNECTION',
      message: `Connection Error: Unable to reach the mail server (${raw}).`
    }
  }
  return { code: 'CONNECTION', message: `IMAP error: ${raw}` }
}

// ---------------------------------------------------------------------------
// Folder discovery
// ---------------------------------------------------------------------------

/** Common Spam/Junk/Trash folder name fragments across providers/locales. */
const JUNK_HINTS = [
  'spam',
  'junk',
  'bulk',
  'trash',
  'deleted',
  'thư rác', // Vietnamese "spam"
  'quảng cáo' // Vietnamese "promotions"
]

/**
 * Ordered list of mailboxes to scan: INBOX first, then any junk/trash folders
 * the server actually reports (using SPECIAL-USE flags when available).
 */
async function resolveFolders(client: ImapFlow): Promise<string[]> {
  const folders: string[] = ['INBOX']
  try {
    const list = await client.list()
    for (const box of list) {
      const path = box.path
      if (!path || path.toUpperCase() === 'INBOX') continue
      const flagJunk =
        box.specialUse === '\\Junk' || box.specialUse === '\\Trash'
      const nameJunk = JUNK_HINTS.some((h) => path.toLowerCase().includes(h))
      if (flagJunk || nameJunk) folders.push(path)
    }
  } catch {
    // If LIST fails, fall back to guessing common junk paths.
    folders.push('Spam', 'Junk', 'Bulk Mail', 'Trash')
  }
  // De-dupe preserving order.
  return [...new Set(folders)]
}

// ---------------------------------------------------------------------------
// Main fetch
// ---------------------------------------------------------------------------

interface ScannedMessage {
  subject: string
  from: string
  date?: Date
  text: string
}

/** Scan one mailbox for a Facebook OTP. Returns the result or null if none. */
async function scanFolder(
  client: ImapFlow,
  folder: string,
  scanCount: number,
  cutoff: Date | null
): Promise<FetchOtpResult | null> {
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | null = null
  try {
    lock = await client.getMailboxLock(folder)
  } catch {
    return null // folder not selectable — skip
  }

  try {
    const status = await client.status(folder, { messages: true })
    const total = status.messages ?? 0
    if (total === 0) return null

    const start = Math.max(1, total - scanCount + 1)
    const range = `${start}:*`

    const messages: ScannedMessage[] = []
    for await (const msg of client.fetch(range, { source: true, envelope: true })) {
      if (!msg.source) continue
      const parsed = await simpleParser(msg.source)
      // Combine subject + plain text + HTML (stripped) for extraction.
      const html = typeof parsed.html === 'string' ? parsed.html : ''
      const htmlText = html.replace(/<[^>]+>/g, ' ')
      messages.push({
        subject: parsed.subject ?? '',
        from: parsed.from?.text ?? '',
        date: parsed.date,
        text: `${parsed.subject ?? ''}\n${parsed.text ?? ''}\n${htmlText}`
      })
    }

    // Newest first.
    messages.reverse()

    for (const m of messages) {
      if (cutoff && m.date && m.date < cutoff) continue
      if (!looksLikeFacebook(m.from, m.subject)) continue
      const code = extractOtp(m.text)
      if (code) {
        return {
          success: true,
          code,
          subject: m.subject,
          from: m.from,
          date: m.date?.toISOString(),
          folder
        }
      }
    }
    return null
  } finally {
    lock.release()
  }
}

/**
 * Connect to a mailbox and pull the most recent Facebook confirmation code,
 * checking INBOX then Spam/Junk/Trash. Returns the first match (newest-first).
 */
export async function fetchFacebookOtp(
  email: string,
  emailPass: string,
  options: FetchOtpOptions = {}
): Promise<FetchOtpResult> {
  const user = (email ?? '').trim()
  const pass = emailPass ?? ''
  if (!user || !pass) {
    return {
      success: false,
      error: 'Email and mail password are required.',
      errorCode: 'INPUT'
    }
  }

  const server = resolveImapServer(user, options.mailServer)
  const scanCount = options.scanCount ?? 25
  const timeoutMs = options.timeoutMs ?? 20000
  const withinMinutes = options.withinMinutes ?? 1440 // 24h default
  const cutoff = new Date(Date.now() - withinMinutes * 60_000)

  const opts: ImapFlowOptions = {
    host: server.host,
    port: server.port,
    secure: server.secure,
    // Full email as username, whitespace trimmed.
    auth: { user, pass },
    logger: false,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    connectionTimeout: timeoutMs,
    // Survive providers with strict / self-signed certificate chains.
    tls: { rejectUnauthorized: false }
  }

  const client = new ImapFlow(opts)

  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('IMAP timed out')), timeoutMs)
      )
    ])

  let connected = false
  try {
    await withTimeout(client.connect())
    connected = true

    const folders = await resolveFolders(client)

    for (const folder of folders) {
      const hit = await scanFolder(client, folder, scanCount, cutoff)
      if (hit) return hit
    }

    // Connected fine but nothing matched.
    return {
      success: false,
      errorCode: 'NO_CODE',
      error:
        'No Code Found: Connected successfully, but no recent Facebook verification email was found in the Inbox or Spam folders.'
    }
  } catch (err) {
    const { code, message } = classifyError(err)
    // If we never even connected, a generic error is likely connection/auth.
    return { success: false, errorCode: connected ? 'NO_CODE' : code, error: message }
  } finally {
    await client.logout().catch(() => void 0)
  }
}
