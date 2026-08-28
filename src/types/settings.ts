// ---------------------------------------------------------------------------
// General app settings — persisted as a single JSON blob under the
// `app.generalSettings` key in the existing settings key/value table.
// ---------------------------------------------------------------------------

export type BrowserMode = 'headless' | 'headed'

/**
 * 'full' runs every post-login enrichment step (cookies, name, avatar,
 * primary location, created date). 'fast' skips the two steps that each
 * require a full navigation + page interaction (primary_location/info, and
 * clicking the profile heading to open the "Joined Facebook" dialog) — those
 * are the slowest, least essential steps when running large batches.
 */
export type MetadataExtractionMode = 'full' | 'fast'

export interface AppSettings {
  defaultConcurrency: number
  browserMode: BrowserMode
  customChromiumPath: string
  delayMinSeconds: number
  delayMaxSeconds: number
  autoSaveCookies: boolean
  /** Empty string = use the default {userData}/profiles directory. */
  customProfileDirectory: string
  /** Scenario id to preselect on startup; null = "No scenario (login only)". */
  defaultScenarioId: number | null
  /**
   * The scenario the user most recently had selected in the Scenario
   * dropdown — distinct from defaultScenarioId (an explicit General Settings
   * configuration value). This is what "remember my last choice across
   * restarts" actually means; kept in SQLite (not just localStorage) since
   * localStorage under a packaged app's file:// renderer origin has been
   * observed to not reliably survive every restart, while the SQLite
   * settings table always does. null = "No scenario (login only)" was last
   * selected; undefined/omitted = no selection has ever been made yet, so
   * the UI should fall back to defaultScenarioId instead.
   */
  lastActiveScenarioId?: number | null
  metadataExtractionMode: MetadataExtractionMode
  /** 2Captcha.com API key, used by twoCaptchaService.ts. Empty = not configured. */
  twoCaptchaApiKey: string
  /** Block image/media/font requests (except on checkpoint pages) to cut RAM/CPU usage across many concurrent instances. */
  blockMedia: boolean
  /**
   * When a queued account already has a live/logged-in session (its saved
   * cookie is still valid — checked by DOM presence of the login form, not
   * navigating through the credential/2FA flow at all), go straight to the
   * scenario's warm-up actions instead of running full auto-login. This is
   * runAutoLogin's actual behavior unconditionally (there's no reason to
   * ever force re-entering credentials on an already-valid session) — this
   * setting instead controls whether the warm-up scenario runs at all in
   * that fast path. Off: an already-live account is still classified/
   * refreshed but skips the scenario's actions, useful for a pure
   * liveness-check batch that shouldn't also act on every account it finds
   * already logged in.
   */
  directWarmup: boolean
  /**
   * This PC's persistent, human-shareable Cloud Sync identifier (format:
   * `TFA` + 5 digits, e.g. `TFA90488`) — generated once on first use and
   * never regenerated afterward, so a Machine ID printed/shared once stays
   * valid. Distinct from license.ts's deviceHash (a SHA-256 hex string
   * bound to hardware for license enforcement) — this one only needs to be
   * short and easy for a person to read aloud or type, not cryptographically
   * tied to anything. undefined = never generated yet.
   */
  machineId?: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultConcurrency: 3,
  browserMode: 'headless',
  customChromiumPath: '',
  delayMinSeconds: 2,
  delayMaxSeconds: 6,
  autoSaveCookies: true,
  customProfileDirectory: '',
  defaultScenarioId: null,
  metadataExtractionMode: 'full',
  twoCaptchaApiKey: '',
  blockMedia: false,
  directWarmup: true
}

export const SETTINGS_KEY = 'app.generalSettings'
