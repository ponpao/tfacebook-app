// ---------------------------------------------------------------------------
// sessionGuard.ts  — Verify active session for marketing automation flows.
// If an account is Logged Out, Checkpointed, or Suspended, immediately
// detects the condition, updates the DB/Activity, and signals the caller
// to close the browser and halt the flow.
// ---------------------------------------------------------------------------
import type { Page } from 'playwright'
import type { Account } from '../../types/account'
import * as accountsRepo from '../db/accountsRepo'
import { generateTOTP } from './totp'

export interface SessionVerificationResult {
  live: boolean
  status: 'Live' | 'Checkpoint' | 'Die' | 'Changed Pass' | 'Unknown'
  detail: string
}

/**
 * Check if the loaded page has an active Facebook session.
 * Automatically tries one-tap login ("Continue" button) or credential fill if present.
 * If logged out / checkpoint / die, updates DB and returns live: false.
 */
export async function verifyActiveSession(
  page: Page,
  account: Account,
  signal?: AbortSignal,
  onProgress?: (label: string) => void
): Promise<SessionVerificationResult> {
  if (signal?.aborted) {
    return { live: false, status: 'Unknown', detail: 'Cancelled by user' }
  }

  // 1. One-tap Account Chooser ("Continue as [Name]" or "Continue")
  const continueBtn = page
    .locator('div[role="button"]:has-text("Continue"), button:has-text("Continue"), [aria-label="Continue"]')
    .first()
  if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await continueBtn.click({ timeout: 3000, force: true }).catch(() => void 0)
    await page.waitForTimeout(2500)
  }

  let url = page.url()
  let body = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase()

  // 2. Checkpoint detection
  if (
    url.includes('/checkpoint/') ||
    url.includes('checkpoint') ||
    url.includes('/two_step_verification/') ||
    body.includes('confirm your identity') ||
    body.includes('confirm you are human') ||
    body.includes("confirm you're human") ||
    body.includes('security check') ||
    body.includes('enter security code') ||
    body.includes('help us confirm it is you') ||
    body.includes('your account has been locked') ||
    body.includes('account locked') ||
    body.includes('we noticed unusual activity')
  ) {
    // Check if 2FA code is requested and we have 2FA secret
    const is2faScreen = url.includes('two_step_verification') || body.includes('enter the 6-digit code') || body.includes('approvals code')
    if (is2faScreen && account.two_fa?.trim()) {
      const totp = generateTOTP(account.two_fa)
      if (totp) {
        onProgress?.('Resolving 2FA prompt...')
        const codeInput = page.locator('input[type="text"], input[type="number"], input[name="approvals_code"]').first()
        if (await codeInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          await codeInput.fill(totp)
          const submit2fa = page.locator('button[type="submit"], div[role="button"]:has-text("Continue"), button:has-text("Submit")').first()
          await submit2fa.click({ force: true }).catch(() => void 0)
          await page.waitForTimeout(3500)
          url = page.url()
          body = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase()
        }
      }
    }

    if (url.includes('/checkpoint/') || url.includes('checkpoint') || body.includes('confirm your identity') || body.includes('confirm you are human')) {
      const detail = 'Checkpoint detected'
      accountsRepo.updateAccount(account.id, {
        status: 'Checkpoint',
        status_detail: detail,
        live_status: detail,
        last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
      })
      onProgress?.(detail)
      return { live: false, status: 'Checkpoint', detail }
    }
  }

  // 3. Disabled / Suspended / Die detection
  if (
    url.includes('/disabled') ||
    body.includes('account disabled') ||
    body.includes('your account has been disabled') ||
    body.includes('your account has been suspended') ||
    body.includes('we suspended your account') ||
    body.includes('account suspended')
  ) {
    const detail = 'Account Disabled / Suspended'
    accountsRepo.updateAccount(account.id, {
      status: 'Die',
      status_detail: detail,
      live_status: detail,
      last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
    })
    onProgress?.(detail)
    return { live: false, status: 'Die', detail }
  }

  // 4. Logged Out / Login page detection
  const emailInput = page.locator('input[name="email"], input[id="email"]').first()
  const passInput = page.locator('input[name="pass"], input[id="pass"]').first()
  const hasLoginForm = (await emailInput.isVisible({ timeout: 1000 }).catch(() => false)) || (await passInput.isVisible({ timeout: 1000 }).catch(() => false))

  const isLoggedOut =
    url.includes('/login') ||
    url.endsWith('/login.php') ||
    body.includes('log in to facebook') ||
    body.includes('log into facebook') ||
    hasLoginForm

  if (isLoggedOut) {
    // Attempt auto credential recovery if password exists
    if (account.password?.trim()) {
      onProgress?.('Attempting auto login recovery...')
      const loginBtn = page.locator('button[name="login"], button[type="submit"], div[role="button"]:has-text("Log In")').first()
      if (await emailInput.isVisible({ timeout: 1500 }).catch(() => false)) {
        await emailInput.fill(account.uid || account.email || '')
        await passInput.fill(account.password)
        await loginBtn.click({ force: true }).catch(() => void 0)
        await page.waitForTimeout(3500)

        // Handle 2FA if prompted
        if (page.url().includes('checkpoint') || page.url().includes('two_step_verification')) {
          if (account.two_fa?.trim()) {
            const totp = generateTOTP(account.two_fa)
            if (totp) {
              const codeInput = page.locator('input[type="text"], input[type="number"], input[name="approvals_code"]').first()
              if (await codeInput.isVisible({ timeout: 4000 }).catch(() => false)) {
                await codeInput.fill(totp)
                const submit2fa = page.locator('button[type="submit"], div[role="button"]:has-text("Continue"), button:has-text("Submit")').first()
                await submit2fa.click({ force: true }).catch(() => void 0)
                await page.waitForTimeout(3500)
              }
            }
          }
        }

        if (!page.url().includes('login') && !page.url().includes('checkpoint')) {
          onProgress?.('Session recovered')
          return { live: true, status: 'Live', detail: 'Session active' }
        }
      }
    }

    const detail = 'Logged Out / Session Expired'
    accountsRepo.updateAccount(account.id, {
      status_detail: detail,
      live_status: detail,
      last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
    })
    onProgress?.(detail)
    return { live: false, status: 'Unknown', detail }
  }

  // 5. Wrong Password detection
  if (body.includes('the password that you') || body.includes('incorrect password') || body.includes('wrong password')) {
    const detail = 'Wrong Password'
    accountsRepo.updateAccount(account.id, {
      status: 'Changed Pass',
      status_detail: detail,
      live_status: detail,
      last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
    })
    onProgress?.(detail)
    return { live: false, status: 'Changed Pass', detail }
  }

  return { live: true, status: 'Live', detail: 'Session active' }
}
