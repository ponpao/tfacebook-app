// ---------------------------------------------------------------------------
// prepare-chromium.cjs — copies the Playwright Chromium builds that are
// already installed in the local dev cache into ./resources/ms-playwright,
// so electron-builder can ship them as an extraResource inside the packaged
// app. End users then never need to run `playwright install` themselves.
//
// Stages BOTH `chromium-{rev}` (the full browser, used for headed launches)
// AND `chromium_headless_shell-{rev}` (a separate, smaller binary Playwright
// 1.4x+ uses BY DEFAULT for any headless launch that doesn't pass an
// explicit `channel`). These are genuinely two different downloads/folders
// — staging only `chromium-*` (an earlier version of this script's bug)
// left every headless launch (avatar extraction, Check Live/Die, a headless
// queue run) throwing "Executable doesn't exist at
// .../chrome-headless-shell.exe" on a client PC with no dev cache to fall
// back on, since the packaged app only ever has exactly what was staged
// here.
//
// Run once before `npm run build:win` (or whenever the pinned Chromium
// version changes). Safe to re-run — it clears the destination first.
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const os = require('os')

function findPlaywrightCacheDir() {
  const envDir = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (envDir && envDir !== '0' && fs.existsSync(envDir)) return envDir

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright')
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

const cacheDir = findPlaywrightCacheDir()
if (!fs.existsSync(cacheDir)) {
  console.error(`[prepare-chromium] Playwright cache not found at ${cacheDir}.`)
  console.error('[prepare-chromium] Run "npx playwright install chromium" first, then retry.')
  process.exit(1)
}

// Stage only the exact revisions this installed playwright-core version
// actually requires — the dev cache often accumulates several old revisions
// from past `npm install`s, and shipping all of them would bloat the
// installer by hundreds of MB for nothing.
const browsersJsonPath = path.join(
  path.dirname(require.resolve('playwright-core/package.json')),
  'browsers.json'
)
const browsersJson = JSON.parse(fs.readFileSync(browsersJsonPath, 'utf8'))

// Both families use the SAME revision number as each other in practice (they
// ship from the same Chromium build), but each is looked up by its own
// browsers.json entry rather than assumed, in case that ever changes.
const BROWSER_FAMILIES = [
  { browsersJsonName: 'chromium', folderPrefix: 'chromium-' },
  { browsersJsonName: 'chromium-headless-shell', folderPrefix: 'chromium_headless_shell-' }
]

const destRoot = path.join(__dirname, '..', 'resources', 'ms-playwright')
fs.rmSync(destRoot, { recursive: true, force: true })
fs.mkdirSync(destRoot, { recursive: true })

let totalStaged = 0
let anyMissingRequired = false

for (const { browsersJsonName, folderPrefix } of BROWSER_FAMILIES) {
  const entry = browsersJson.browsers.find((b) => b.name === browsersJsonName)
  const requiredFolder = entry ? `${folderPrefix}${entry.revision}` : null

  const allDirsForFamily = fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(folderPrefix))
    .map((e) => e.name)

  const wanted =
    requiredFolder && allDirsForFamily.includes(requiredFolder)
      ? [requiredFolder]
      : allDirsForFamily // fallback: ship whatever is present for this family

  if (wanted.length === 0) {
    console.error(`[prepare-chromium] No ${folderPrefix}* folder found under ${cacheDir} for "${browsersJsonName}".`)
    anyMissingRequired = true
    continue
  }
  if (requiredFolder && wanted.length === 1 && wanted[0] === requiredFolder) {
    console.log(`[prepare-chromium] staging required revision only: ${requiredFolder}`)
  } else {
    console.log(
      `[prepare-chromium] required revision ${requiredFolder} not found in cache for "${browsersJsonName}" — staging all present builds instead`
    )
  }

  for (const name of wanted) {
    const src = path.join(cacheDir, name)
    const dest = path.join(destRoot, name)
    console.log(`[prepare-chromium] copying ${name}...`)
    copyDir(src, dest)
    totalStaged += 1
  }
}

if (anyMissingRequired) {
  console.error(
    '[prepare-chromium] Run "npx playwright install chromium chromium-headless-shell" first, then retry.'
  )
  process.exit(1)
}

console.log(`[prepare-chromium] done — ${totalStaged} browser build(s) staged in resources/ms-playwright`)
