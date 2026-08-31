// ---------------------------------------------------------------------------
// GeneralSettingsModal.tsx  — app-wide automation defaults: concurrency,
// browser mode, custom Chromium path, action delay range, cookie auto-save.
// Persisted via window.api.settings.getAppSettings/setAppSettings (SQLite).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { Settings, FolderOpen, Eye, EyeOff } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import { useLanguageStore } from '../../store/useLanguageStore'
import { DEFAULT_SETTINGS, type AppSettings, type BrowserMode, type HardwareMode } from '../../../types/settings'

export function GeneralSettingsModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const showToast = useAccountStore((s) => s.showToast)
  const setThreadCount = useAccountStore((s) => s.setThreadCount)
  const scenarios = useAccountStore((s) => s.scenarios)

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.api.settings
      .getAppSettings()
      .then(setSettings)
      .finally(() => setLoading(false))
  }, [open])

  const patch = (p: Partial<AppSettings>): void => setSettings((s) => ({ ...s, ...p }))

  const browseChromium = async (): Promise<void> => {
    const path = await window.api.utils.selectChromiumExecutable()
    if (path) patch({ customChromiumPath: path })
  }

  const browseProfileDirectory = async (): Promise<void> => {
    const path = await window.api.utils.selectProfileDirectory()
    if (path) patch({ customProfileDirectory: path })
  }

  const browseAvatarDirectory = async (): Promise<void> => {
    const path = await window.api.utils.selectAvatarDirectory()
    if (path) patch({ avatarStoragePath: path })
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const clamped: AppSettings = {
        ...settings,
        defaultConcurrency: Math.max(1, Math.min(10, Math.floor(settings.defaultConcurrency) || 1)),
        delayMinSeconds: Math.max(0, settings.delayMinSeconds),
        delayMaxSeconds: Math.max(0, settings.delayMaxSeconds)
      }
      await window.api.settings.setAppSettings(clamped)
      setThreadCount(clamped.defaultConcurrency)
      // NOTE: this intentionally does NOT call setActiveScenarioId() anymore.
      // defaultScenarioId (a General Settings configuration value) and the
      // user's actually-currently-selected scenario are two different
      // things — forcing the dropdown to defaultScenarioId on every settings
      // save (even ones unrelated to scenarios, e.g. changing concurrency)
      // was silently discarding whatever scenario the user had picked in the
      // main toolbar. defaultScenarioId only matters for a genuinely fresh
      // app install/profile with no prior selection (see refreshScenarios()).
      showToast('General settings saved.')
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const t = useLanguageStore((s) => s.t)

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t('generalSettingsTitle')}
      icon={Settings}
      width="max-w-lg"
      footer={
        <>
          <button className="win-btn" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </button>
          <button className="win-btn-accent" onClick={() => void save()} disabled={saving || loading}>
            {saving ? 'Saving…' : t('saveSettings')}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="flex h-40 items-center justify-center text-[12px] text-slate-500">
          Loading settings…
        </div>
      ) : (
        <div className="flex flex-col gap-4 text-[12px]">
          <fieldset className="win-fieldset flex items-center gap-3">
            <legend>{t('defaultConcurrency')}</legend>
            <input
              type="number"
              min={1}
              max={10}
              className="win-input w-16 text-center"
              value={settings.defaultConcurrency}
              onChange={(e) => patch({ defaultConcurrency: Number(e.target.value) })}
            />
            <span className="text-[11px] text-slate-500">{t('accountsRunInParallel')}</span>
          </fieldset>

          <fieldset className="win-fieldset">
            <legend>{t('browserMode')}</legend>
            <div className="flex gap-4 py-1">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="browser-mode"
                  checked={settings.browserMode === 'headless'}
                  onChange={() => patch({ browserMode: 'headless' as BrowserMode })}
                />
                {t('headlessDesc')}
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="browser-mode"
                  checked={settings.browserMode === 'headed'}
                  onChange={() => patch({ browserMode: 'headed' as BrowserMode })}
                />
                {t('headedDesc')}
              </label>
            </div>
          </fieldset>

          <fieldset className="win-fieldset">
            <legend>{t('hardwareRunningMode')}</legend>
            <div className="flex gap-4 py-1">
              <label className="flex items-center gap-1.5" title="Forces software rendering — most compatible when running many concurrent instances without a capable/stable GPU driver.">
                <input
                  type="radio"
                  name="hardware-mode"
                  checked={settings.hardwareMode === 'cpu'}
                  onChange={() => patch({ hardwareMode: 'cpu' as HardwareMode })}
                />
                {t('cpuOnly')}
              </label>
              <label className="flex items-center gap-1.5" title="Forces GPU rasterization, WebGL, and hardware acceleration on.">
                <input
                  type="radio"
                  name="hardware-mode"
                  checked={settings.hardwareMode === 'gpu'}
                  onChange={() => patch({ hardwareMode: 'gpu' as HardwareMode })}
                />
                {t('gpuAcceleration')}
              </label>
              <label className="flex items-center gap-1.5" title="Chromium's own default hybrid behavior — no extra flags either way.">
                <input
                  type="radio"
                  name="hardware-mode"
                  checked={settings.hardwareMode === 'auto'}
                  onChange={() => patch({ hardwareMode: 'auto' as HardwareMode })}
                />
                {t('autoBoth')}
              </label>
            </div>
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-slate-700">
              {t('customChromiumPath')}
            </span>
            <div className="flex gap-1.5">
              <input
                className="win-input flex-1"
                placeholder={t('customChromiumPlaceholder')}
                value={settings.customChromiumPath}
                onChange={(e) => patch({ customChromiumPath: e.target.value })}
              />
              <button className="win-btn" onClick={() => void browseChromium()}>
                <FolderOpen size={13} className="text-[#4a6a8a]" />
                {t('browse')}
              </button>
            </div>
          </label>

          <fieldset className="win-fieldset flex items-center gap-3">
            <legend>{t('delayRangeBetweenActions')}</legend>
            <label className="flex items-center gap-1.5">
              {t('minS')}
              <input
                type="number"
                min={0}
                max={300}
                className="win-input w-16 text-center"
                value={settings.delayMinSeconds}
                onChange={(e) => patch({ delayMinSeconds: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center gap-1.5">
              {t('maxS')}
              <input
                type="number"
                min={0}
                max={300}
                className="win-input w-16 text-center"
                value={settings.delayMaxSeconds}
                onChange={(e) => patch({ delayMaxSeconds: Number(e.target.value) })}
              />
            </label>
          </fieldset>

          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={settings.autoSaveCookies}
              onChange={(e) => patch({ autoSaveCookies: e.target.checked })}
            />
            {t('autoSaveCookies')}
          </label>

          <label className="flex items-center gap-1.5" title="When a queued account's saved cookie is still valid, go straight to the warm-up scenario instead of running full auto-login — credentials are only ever entered if the session turns out to be dead/logged out.">
            <input
              type="checkbox"
              checked={settings.directWarmup}
              onChange={(e) => patch({ directWarmup: e.target.checked })}
            />
            {t('directWarmup')}
          </label>

          <label className="flex items-center gap-1.5" title="Once a login-queue run finishes with no other batch running, shows a 60-second countdown you can cancel before this PC actually shuts down. Windows only.">
            <input
              type="checkbox"
              checked={settings.autoShutdownAfterQueue}
              onChange={(e) => patch({ autoShutdownAfterQueue: e.target.checked })}
            />
            {t('autoShutdownPc')}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-slate-700">
              {t('chromeProfilePath')}
            </span>
            <div className="flex gap-1.5">
              <input
                className="win-input flex-1"
                placeholder="Leave empty to use the default userData/profiles folder"
                value={settings.customProfileDirectory}
                onChange={(e) => patch({ customProfileDirectory: e.target.value })}
              />
              <button className="win-btn" onClick={() => void browseProfileDirectory()}>
                <FolderOpen size={13} className="text-[#4a6a8a]" />
                {t('browse')}
              </button>
            </div>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-slate-700">
              {t('avatarDownloadDir')}
            </span>
            <div className="flex gap-1.5">
              <input
                className="win-input flex-1"
                placeholder="Leave empty to use the default userData/avatars folder"
                value={settings.avatarStoragePath}
                onChange={(e) => patch({ avatarStoragePath: e.target.value })}
              />
              <button className="win-btn" onClick={() => void browseAvatarDirectory()}>
                <FolderOpen size={13} className="text-[#4a6a8a]" />
                {t('browse')}
              </button>
            </div>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-slate-700">Default Scenario</span>
            <select
              className="win-input"
              value={settings.defaultScenarioId ?? ''}
              onChange={(e) =>
                patch({ defaultScenarioId: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">No scenario (login only)</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-slate-500">
              Preselected in the Scenario dropdown when the app starts.
            </span>
          </label>

          <fieldset className="win-fieldset">
            <legend>Metadata Extraction Mode</legend>
            <div className="flex flex-col gap-1.5 py-1">
              <label className="flex items-start gap-1.5">
                <input
                  type="radio"
                  name="metadata-mode"
                  className="mt-0.5"
                  checked={settings.metadataExtractionMode === 'full'}
                  onChange={() => patch({ metadataExtractionMode: 'full' })}
                />
                <span>
                  <span className="font-medium text-slate-700">Full Extraction</span>
                  <br />
                  <span className="text-[11px] text-slate-500">
                    Cookies, Name, Avatar (.jpg), Primary Location, Created Date.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-1.5">
                <input
                  type="radio"
                  name="metadata-mode"
                  className="mt-0.5"
                  checked={settings.metadataExtractionMode === 'fast'}
                  onChange={() => patch({ metadataExtractionMode: 'fast' })}
                />
                <span>
                  <span className="font-medium text-slate-700">Fast Mode (Name &amp; Cookies Only)</span>
                  <br />
                  <span className="text-[11px] text-slate-500">
                    Skips Primary Location and Created Date scraping for high-speed batch runs.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-slate-700">
              {t('twoCaptchaApiKey')} <span className="text-slate-400">(optional)</span>
            </span>
            <div className="flex gap-1.5">
              <input
                type={showApiKey ? 'text' : 'password'}
                className="win-input flex-1 font-mono"
                placeholder="Paste your 2captcha.com API key"
                value={settings.twoCaptchaApiKey}
                onChange={(e) => patch({ twoCaptchaApiKey: e.target.value })}
              />
              <button
                type="button"
                className="win-btn"
                onClick={() => setShowApiKey((v) => !v)}
                title={showApiKey ? 'Hide' : 'Show'}
              >
                {showApiKey ? <EyeOff size={13} className="text-[#4a6a8a]" /> : <Eye size={13} className="text-[#4a6a8a]" />}
              </button>
            </div>
            <span className="text-[11px] text-slate-500">
              Used to solve image/reCAPTCHA challenges via the 2Captcha.com API.
            </span>
          </label>

          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={settings.blockMedia}
              onChange={(e) => patch({ blockMedia: e.target.checked })}
            />
            {t('blockMediaImages')}
          </label>
        </div>
      )}
    </ModalShell>
  )
}
