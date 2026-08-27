// ---------------------------------------------------------------------------
// twoCaptchaService.ts  — thin client for the 2Captcha HTTP API.
// Two request types are supported: an image captcha (base64 image in, text
// answer out) and reCAPTCHA v2 (site key + page URL in, g-recaptcha-response
// token out). Both follow 2Captcha's standard submit-then-poll flow: POST to
// /in.php to queue the job, then poll /res.php until it reports ready.
// ---------------------------------------------------------------------------

const API_BASE = 'https://2captcha.com'
const POLL_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 120000

export class TwoCaptchaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwoCaptchaError'
  }
}

interface InResponse {
  status: number
  request: string
}

async function submit(apiKey: string, params: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({ key: apiKey, json: '1', ...params })
  const res = await fetch(`${API_BASE}/in.php`, { method: 'POST', body })
  const json = (await res.json().catch(() => null)) as InResponse | null
  if (!json || json.status !== 1) {
    throw new TwoCaptchaError(`2Captcha submit failed: ${json?.request ?? `HTTP ${res.status}`}`)
  }
  return json.request // the captcha id
}

async function poll(apiKey: string, captchaId: string, timeoutMs: number): Promise<string> {
  const start = Date.now()
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const res = await fetch(
      `${API_BASE}/res.php?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(captchaId)}&json=1`
    )
    const json = (await res.json().catch(() => null)) as InResponse | null
    if (json?.status === 1) return json.request
    if (json && json.request !== 'CAPCHA_NOT_READY') {
      throw new TwoCaptchaError(`2Captcha solve failed: ${json.request}`)
    }
    if (Date.now() - start >= timeoutMs) {
      throw new TwoCaptchaError(`2Captcha timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
  }
}

/**
 * Solve a plain image captcha (distorted text in an image). `base64Image`
 * must be the raw base64-encoded image bytes with no data: URI prefix.
 * Resolves to the recognized text.
 */
export async function solveImageCaptcha(
  apiKey: string,
  base64Image: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string> {
  if (!apiKey?.trim()) throw new TwoCaptchaError('No 2Captcha API key configured')
  const captchaId = await submit(apiKey, { method: 'base64', body: base64Image })
  return poll(apiKey, captchaId, timeoutMs)
}

/**
 * Solve a reCAPTCHA v2 challenge for a given site key + page URL. Resolves
 * to the g-recaptcha-response token to inject into the page's response
 * field (or submit via the site's own callback) before continuing.
 */
export async function solveRecaptchaV2(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string> {
  if (!apiKey?.trim()) throw new TwoCaptchaError('No 2Captcha API key configured')
  const captchaId = await submit(apiKey, {
    method: 'userrecaptcha',
    googlekey: siteKey,
    pageurl: pageUrl
  })
  return poll(apiKey, captchaId, timeoutMs)
}

