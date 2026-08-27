// ---------------------------------------------------------------------------
// twoFactor.ts  — RFC-6238 TOTP generator (SHA-1, 6 digits, 30s step).
// Pure browser implementation using WebCrypto (crypto.subtle) — no deps.
// Handles messy real-world secrets: spaces, lowercase, and otpauth:// URIs.
// ---------------------------------------------------------------------------

/** Seconds remaining in the current 30-second TOTP window. */
export function secondsRemaining(step = 30): number {
  return step - (Math.floor(Date.now() / 1000) % step)
}

/**
 * Extract and clean a Base32 secret from a raw 2FA field. Accepts:
 *   - a bare Base32 secret ("JBSW Y3DP EHPK 3PXP")
 *   - an otpauth:// URI ("otpauth://totp/label?secret=XXXX&...")
 * Returns the uppercase Base32 secret with padding/spaces removed, or ''.
 */
export function sanitizeSecret(raw: string): string {
  if (!raw) return ''
  let s = raw.trim()

  // otpauth:// URI → pull the `secret` query parameter.
  if (/^otpauth:\/\//i.test(s)) {
    try {
      const url = new URL(s)
      s = url.searchParams.get('secret') ?? ''
    } catch {
      const m = s.match(/[?&]secret=([^&]+)/i)
      s = m ? decodeURIComponent(m[1]) : ''
    }
  }

  // Strip spaces, dashes, padding; uppercase for Base32.
  return s.replace(/[\s-]/g, '').replace(/=+$/g, '').toUpperCase()
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode a Base32 (RFC 4648) string into bytes (ArrayBuffer-backed). */
function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/=+$/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) continue // skip anything not in the alphabet
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  const buf = new Uint8Array(new ArrayBuffer(out.length))
  buf.set(out)
  return buf
}

/**
 * Generate a TOTP code for the given secret at an optional timestamp (ms).
 * Returns a zero-padded string of `digits` length, or null if the secret is
 * unusable.
 */
export async function generateTOTP(
  rawSecret: string,
  { digits = 6, step = 30, atMs = Date.now() }: { digits?: number; step?: number; atMs?: number } = {}
): Promise<string | null> {
  const secret = sanitizeSecret(rawSecret)
  if (!secret) return null

  const key = base32Decode(secret)
  if (key.length === 0) return null

  // 8-byte big-endian counter = floor(unixTime / step).
  const counter = Math.floor(atMs / 1000 / step)
  const msg = new Uint8Array(new ArrayBuffer(8))
  // Only the low 32 bits matter for realistic timestamps.
  let tmp = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = tmp & 0xff
    tmp = Math.floor(tmp / 256)
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    )
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg))

    // Dynamic truncation (RFC 4226 §5.3).
    const offset = sig[sig.length - 1] & 0x0f
    const binCode =
      ((sig[offset] & 0x7f) << 24) |
      ((sig[offset + 1] & 0xff) << 16) |
      ((sig[offset + 2] & 0xff) << 8) |
      (sig[offset + 3] & 0xff)

    const code = binCode % 10 ** digits
    return code.toString().padStart(digits, '0')
  } catch {
    return null
  }
}
