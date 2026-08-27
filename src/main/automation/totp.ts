// ---------------------------------------------------------------------------
// totp.ts  — RFC-6238 TOTP generator for the MAIN process (Node crypto).
// Mirrors the renderer's twoFactor.ts but uses node:crypto HMAC.
// ---------------------------------------------------------------------------
import { createHmac } from 'crypto'

/** Seconds remaining in the current TOTP window. */
export function secondsRemaining(step = 30): number {
  return step - (Math.floor(Date.now() / 1000) % step)
}

/** Clean a 2FA secret: strip spaces/dashes, unwrap otpauth:// URIs, uppercase. */
export function sanitizeSecret(raw: string): string {
  if (!raw) return ''
  let s = raw.trim()
  if (/^otpauth:\/\//i.test(s)) {
    try {
      const url = new URL(s)
      s = url.searchParams.get('secret') ?? ''
    } catch {
      const m = s.match(/[?&]secret=([^&]+)/i)
      s = m ? decodeURIComponent(m[1]) : ''
    }
  }
  return s.replace(/[\s-]/g, '').replace(/=+$/g, '').toUpperCase()
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

/** Generate the current TOTP code, or null when the secret is unusable. */
export function generateTOTP(
  rawSecret: string,
  { digits = 6, step = 30, atMs = Date.now() }: { digits?: number; step?: number; atMs?: number } = {}
): string | null {
  const secret = sanitizeSecret(rawSecret)
  if (!secret) return null

  const key = base32Decode(secret)
  if (key.length === 0) return null

  const counter = Math.floor(atMs / 1000 / step)
  const msg = Buffer.alloc(8)
  let tmp = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = tmp & 0xff
    tmp = Math.floor(tmp / 256)
  }

  const h = createHmac('sha1', key).update(msg).digest()
  const offset = h[h.length - 1] & 0x0f
  const binCode =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff)

  return (binCode % 10 ** digits).toString().padStart(digits, '0')
}
