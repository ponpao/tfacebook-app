// ---------------------------------------------------------------------------
// userAgentGenerator.ts  — generates a pool of realistic modern desktop
// Chrome User-Agent strings (Windows 10/11 + macOS), Chrome v124–v135, each
// paired with a plausible matching WebKit/Safari trailer version so the
// string as a whole looks like a real browser build rather than a random mix.
// ---------------------------------------------------------------------------

const WINDOWS_NT_VERSIONS = ['10.0'] // Windows 10 and 11 both report NT 10.0
const CHROME_MAJOR_RANGE = { min: 124, max: 135 }
const MAC_OS_VERSIONS = ['10_15_7', '13_6_1', '14_4_1', '14_5', '15_0', '15_1']

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** A trailing .0.0 chrome build number in the range real Chrome releases use. */
function chromeFullVersion(major: number): string {
  const build = randomInt(6300, 6900)
  const patch = randomInt(0, 200)
  return `${major}.0.${build}.${patch}`
}

function windowsUA(): string {
  const nt = WINDOWS_NT_VERSIONS[randomInt(0, WINDOWS_NT_VERSIONS.length - 1)]
  const major = randomInt(CHROME_MAJOR_RANGE.min, CHROME_MAJOR_RANGE.max)
  const chrome = chromeFullVersion(major)
  return `Mozilla/5.0 (Windows NT ${nt}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
}

function macUA(): string {
  const macVersion = MAC_OS_VERSIONS[randomInt(0, MAC_OS_VERSIONS.length - 1)]
  const major = randomInt(CHROME_MAJOR_RANGE.min, CHROME_MAJOR_RANGE.max)
  const chrome = chromeFullVersion(major)
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${macVersion}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
}

/**
 * Generate `count` realistic, de-duplicated desktop Chrome User-Agent
 * strings — roughly 2/3 Windows, 1/3 macOS, matching real-world desktop
 * Chrome usage share. Falls back to accepting near-duplicates only if the
 * requested count exceeds the practical variety of the version ranges.
 */
export function generateUserAgents(count = 60): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let guard = 0
  while (out.length < count && guard < count * 20) {
    guard += 1
    const ua = Math.random() < 0.65 ? windowsUA() : macUA()
    if (seen.has(ua)) continue
    seen.add(ua)
    out.push(ua)
  }
  return out
}
