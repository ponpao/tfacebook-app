// ---------------------------------------------------------------------------
// ChangeInfoModal.tsx  — Batch Change Info: About Information (bio/work/
// current city/hometown/high school, each pipe-delimited spin text), Profile
// Picture, Cover Photo, and Security (password + 2FA reset).
// Each section is enabled independently via its own checkbox.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { UserCog, FolderOpen } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'

function AboutFieldRow({
  label,
  placeholder,
  enabled,
  setEnabled,
  value,
  setValue
}: {
  label: string
  placeholder: string
  enabled: boolean
  setEnabled: (v: boolean) => void
  value: string
  setValue: (v: string) => void
}): React.JSX.Element {
  return (
    <div>
      <label className="flex items-center gap-2 font-medium text-slate-800">
        <input
          type="checkbox"
          className="accent-[#0078d4]"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {label}
      </label>
      {enabled && (
        <input
          className="win-input mt-1 ml-6 w-[calc(100%-1.5rem)] font-mono"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
    </div>
  )
}

export function ChangeInfoModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const selectedIds = useAccountStore((s) => s.selectedIds)
  const threadCount = useAccountStore((s) => s.threadCount)
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)

  const [doPassword, setDoPassword] = useState(false)
  const [passwordPattern, setPasswordPattern] = useState('Aa1!XXXXXXXX')

  // Section 1: About Information
  const [doBio, setDoBio] = useState(false)
  const [bioTemplate, setBioTemplate] = useState('')
  const [doWork, setDoWork] = useState(false)
  const [workTemplate, setWorkTemplate] = useState('')
  const [doCurrentCity, setDoCurrentCity] = useState(false)
  const [currentCityTemplate, setCurrentCityTemplate] = useState('')
  const [doHometown, setDoHometown] = useState(false)
  const [hometownTemplate, setHometownTemplate] = useState('')
  const [doHighSchool, setDoHighSchool] = useState(false)
  const [highSchoolTemplate, setHighSchoolTemplate] = useState('')
  const [skipIfAlreadySet, setSkipIfAlreadySet] = useState(true)

  // Section 2: Profile Picture
  const [doAvatar, setDoAvatar] = useState(false)
  const [avatarFolder, setAvatarFolder] = useState<string | null>(null)
  const [avatarSkipIfExists, setAvatarSkipIfExists] = useState(false)
  const [avatarDeleteUsed, setAvatarDeleteUsed] = useState(false)

  // Section 3: Cover Photo
  const [doCover, setDoCover] = useState(false)
  const [coverFolder, setCoverFolder] = useState<string | null>(null)
  const [coverSkipIfExists, setCoverSkipIfExists] = useState(false)
  const [coverDeleteUsed, setCoverDeleteUsed] = useState(false)

  // Section 4: Security
  const [do2FA, setDo2FA] = useState(false)

  const [running, setRunning] = useState(false)

  const count = selectedIds().length
  const anyAbout = doBio || doWork || doCurrentCity || doHometown || doHighSchool
  const anyEnabled = doPassword || anyAbout || doAvatar || doCover || do2FA

  const pickAvatarFolder = async (): Promise<void> => {
    const folder = await window.api.utils.selectFolder()
    if (folder) setAvatarFolder(folder)
  }
  const pickCoverFolder = async (): Promise<void> => {
    const folder = await window.api.utils.selectFolder()
    if (folder) setCoverFolder(folder)
  }

  const run = async (): Promise<void> => {
    const ids = selectedIds()
    if (ids.length === 0) {
      showToast('Select at least one account first.')
      return
    }
    if (!anyEnabled) {
      showToast('Enable at least one operation.')
      return
    }
    if (doAvatar && !avatarFolder) {
      showToast('Pick an image folder for the profile picture change.')
      return
    }
    if (doCover && !coverFolder) {
      showToast('Pick an image folder for the cover photo change.')
      return
    }

    setRunning(true)
    showToast(`Change Info: running on ${ids.length} account(s)…`)
    try {
      const summary = await window.api.automation.runChangeInfo({
        accountIds: ids,
        concurrency: threadCount,
        changePassword: doPassword ? { pattern: passwordPattern || undefined } : undefined,
        updateAbout: anyAbout
          ? {
              bio: doBio && bioTemplate.trim() ? { template: bioTemplate } : undefined,
              work: doWork && workTemplate.trim() ? { template: workTemplate } : undefined,
              currentCity:
                doCurrentCity && currentCityTemplate.trim()
                  ? { template: currentCityTemplate }
                  : undefined,
              hometown:
                doHometown && hometownTemplate.trim() ? { template: hometownTemplate } : undefined,
              highSchool:
                doHighSchool && highSchoolTemplate.trim()
                  ? { template: highSchoolTemplate }
                  : undefined,
              skipIfAlreadySet
            }
          : undefined,
        changeAvatar:
          doAvatar && avatarFolder
            ? {
                folderPath: avatarFolder,
                skipIfExists: avatarSkipIfExists,
                deleteUsedImage: avatarDeleteUsed
              }
            : undefined,
        changeCover:
          doCover && coverFolder
            ? {
                folderPath: coverFolder,
                skipIfExists: coverSkipIfExists,
                deleteUsedImage: coverDeleteUsed
              }
            : undefined,
        enable2FA: do2FA
      })
      showToast(
        `Change Info done: ${summary.succeeded}/${summary.total} succeeded, ${summary.failed} failed.`,
        6000
      )
      onClose()
    } finally {
      setRunning(false)
      await refresh()
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Change Info"
      icon={UserCog}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {count} account(s) selected · {threadCount} thread(s)
          </span>
          <button className="win-btn" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button className="win-btn-accent" onClick={() => void run()} disabled={running}>
            {running ? 'Running…' : 'Apply Changes'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        {/* Section 1: About Information */}
        <fieldset className="win-fieldset flex flex-col gap-2.5 p-3">
          <legend>About Information</legend>
          <AboutFieldRow
            label="Bio"
            placeholder="Living life one day at a time|Just here for the vibes"
            enabled={doBio}
            setEnabled={setDoBio}
            value={bioTemplate}
            setValue={setBioTemplate}
          />
          <AboutFieldRow
            label="Work"
            placeholder="Washington|New York|Houston"
            enabled={doWork}
            setEnabled={setDoWork}
            value={workTemplate}
            setValue={setWorkTemplate}
          />
          <AboutFieldRow
            label="Current City"
            placeholder="Washington|New York|Houston"
            enabled={doCurrentCity}
            setEnabled={setDoCurrentCity}
            value={currentCityTemplate}
            setValue={setCurrentCityTemplate}
          />
          <AboutFieldRow
            label="Hometown"
            placeholder="Washington|New York|Houston"
            enabled={doHometown}
            setEnabled={setDoHometown}
            value={hometownTemplate}
            setValue={setHometownTemplate}
          />
          <AboutFieldRow
            label="High School"
            placeholder="Washington|New York|Houston"
            enabled={doHighSchool}
            setEnabled={setDoHighSchool}
            value={highSchoolTemplate}
            setValue={setHighSchoolTemplate}
          />
          <label className="flex items-center gap-2 border-t border-slate-200 pt-2 text-slate-700">
            <input
              type="checkbox"
              className="accent-[#0078d4]"
              checked={skipIfAlreadySet}
              onChange={(e) => setSkipIfAlreadySet(e.target.checked)}
            />
            Don&apos;t change information if it already has a value
          </label>
        </fieldset>

        {/* Section 2: Profile Picture */}
        <fieldset className="win-fieldset flex flex-col gap-2 p-3">
          <legend>Profile Picture</legend>
          <label className="flex items-center gap-2 font-medium text-slate-800">
            <input
              type="checkbox"
              className="accent-[#0078d4]"
              checked={doAvatar}
              onChange={(e) => setDoAvatar(e.target.checked)}
            />
            Profile Download Auto
          </label>
          {doAvatar && (
            <div className="ml-6 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <button className="win-btn" onClick={() => void pickAvatarFolder()}>
                  <FolderOpen size={13} className="text-[#c98a00]" />
                  Path Folder
                </button>
                <span className="truncate text-[11px] text-slate-500">
                  {avatarFolder ?? 'No folder selected — a random unused image is picked per account'}
                </span>
              </div>
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  className="accent-[#0078d4]"
                  checked={avatarSkipIfExists}
                  onChange={(e) => setAvatarSkipIfExists(e.target.checked)}
                />
                Skip profile already exists
              </label>
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  className="accent-[#0078d4]"
                  checked={avatarDeleteUsed}
                  onChange={(e) => setAvatarDeleteUsed(e.target.checked)}
                />
                Delete used image (removes the file from disk after a successful upload)
              </label>
            </div>
          )}
        </fieldset>

        {/* Section 3: Cover Photo */}
        <fieldset className="win-fieldset flex flex-col gap-2 p-3">
          <legend>Cover Photo</legend>
          <label className="flex items-center gap-2 font-medium text-slate-800">
            <input
              type="checkbox"
              className="accent-[#0078d4]"
              checked={doCover}
              onChange={(e) => setDoCover(e.target.checked)}
            />
            Change Cover Photo
          </label>
          {doCover && (
            <div className="ml-6 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <button className="win-btn" onClick={() => void pickCoverFolder()}>
                  <FolderOpen size={13} className="text-[#c98a00]" />
                  Path Folder
                </button>
                <span className="truncate text-[11px] text-slate-500">
                  {coverFolder ?? 'No folder selected — a random unused image is picked per account'}
                </span>
              </div>
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  className="accent-[#0078d4]"
                  checked={coverSkipIfExists}
                  onChange={(e) => setCoverSkipIfExists(e.target.checked)}
                />
                Skip cover already exists
              </label>
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  className="accent-[#0078d4]"
                  checked={coverDeleteUsed}
                  onChange={(e) => setCoverDeleteUsed(e.target.checked)}
                />
                Delete used image (removes the file from disk after a successful upload)
              </label>
            </div>
          )}
        </fieldset>

        {/* Section 4: Security */}
        <fieldset className="win-fieldset flex flex-col gap-2.5 p-3">
          <legend>Security</legend>
          <div>
            <label className="flex items-center gap-2 font-medium text-slate-800">
              <input
                type="checkbox"
                className="accent-[#0078d4]"
                checked={doPassword}
                onChange={(e) => setDoPassword(e.target.checked)}
              />
              Change Password
            </label>
            {doPassword && (
              <div className="mt-1 ml-6 flex items-center gap-2">
                <span className="text-slate-600">Pattern (X = random char):</span>
                <input
                  className="win-input flex-1 font-mono"
                  value={passwordPattern}
                  onChange={(e) => setPasswordPattern(e.target.value)}
                  placeholder="Aa1!XXXXXXXX (blank = fully random)"
                />
              </div>
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 font-medium text-slate-800">
              <input
                type="checkbox"
                className="accent-[#0078d4]"
                checked={do2FA}
                onChange={(e) => setDo2FA(e.target.checked)}
              />
              Enable / Reset 2FA
            </label>
            {do2FA && (
              <p className="mt-1 ml-6 text-[11px] text-slate-500">
                Disables any 2FA currently active on the account, sets up a new authenticator-app
                2FA method, and saves the new secret into the account's 2FA column.
              </p>
            )}
          </div>
        </fieldset>
      </div>
    </ModalShell>
  )
}
