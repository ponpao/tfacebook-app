// ---------------------------------------------------------------------------
// prepare-chromium.cjs — copies the Playwright Chromium build that's already
// installed in the local dev cache into ./resources/ms-playwright, so
// electron-builder can ship it as an extraResource inside the packaged app.
// End users then never need to run `playwright install` themselves.
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

// Stage only the exact chromium revision this installed playwright-core
// version actually requires — the dev cache often accumulates several old
// revisions from past `npm install`s, and shipping all of them would bloat
// the installer by hundreds of MB for nothing.
const browsersJsonPath = path.join(
  path.dirname(require.resolve('playwright-core/package.json')),
  'browsers.json'
)
const browsersJson = JSON.parse(fs.readFileSync(browsersJsonPath, 'utf8'))
const chromiumEntry = browsersJson.browsers.find((b) => b.name === 'chromium')
const requiredFolder = chromiumEntry ? `chromium-${chromiumEntry.revision}` : null

const allChromiumDirs = fs
  .readdirSync(cacheDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('chromium-'))
  .map((e) => e.name)

const wanted = requiredFolder && allChromiumDirs.includes(requiredFolder)
  ? [{ name: requiredFolder }]
  : allChromiumDirs.map((name) => ({ name })) // fallback: ship whatever is present

if (wanted.length === 0) {
  console.error(`[prepare-chromium] No chromium-* folder found under ${cacheDir}.`)
  console.error('[prepare-chromium] Run "npx playwright install chromium" first, then retry.')
  process.exit(1)
}
if (requiredFolder && wanted.length === 1 && wanted[0].name === requiredFolder) {
  console.log(`[prepare-chromium] staging required revision only: ${requiredFolder}`)
} else {
  console.log(
    `[prepare-chromium] required revision ${requiredFolder} not found in cache — staging all present builds instead`
  )
}

const destRoot = path.join(__dirname, '..', 'resources', 'ms-playwright')
fs.rmSync(destRoot, { recursive: true, force: true })
fs.mkdirSync(destRoot, { recursive: true })

for (const entry of wanted) {
  const src = path.join(cacheDir, entry.name)
  const dest = path.join(destRoot, entry.name)
  console.log(`[prepare-chromium] copying ${entry.name}...`)
  copyDir(src, dest)
}

console.log(`[prepare-chromium] done — ${wanted.length} browser build(s) staged in resources/ms-playwright`)
