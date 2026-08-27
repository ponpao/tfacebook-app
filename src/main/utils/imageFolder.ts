// ---------------------------------------------------------------------------
// imageFolder.ts  — pick a random, not-already-used image from a local
// folder for batch avatar changes (each account should get a distinct image
// where possible, so accounts don't all end up with the same avatar).
// ---------------------------------------------------------------------------
import { readdirSync } from 'fs'
import { join, basename, extname as pathExtname } from 'path'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

/** List every image file directly inside `folderPath` (non-recursive). */
export function listImages(folderPath: string): string[] {
  try {
    return readdirSync(folderPath, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => IMAGE_EXTENSIONS.has(extname(name)))
      .map((name) => join(folderPath, name))
  } catch {
    return []
  }
}

function extname(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i).toLowerCase()
}

// Tracks which images have already been assigned during the current app
// session, per folder, so a batch run spreads images across accounts instead
// of repeating the same one. Resets when the app restarts (best-effort —
// this is a variety heuristic, not a strict uniqueness guarantee).
const usedByFolder = new Map<string, Set<string>>()

/**
 * Pick a random image from `folderPath` that hasn't been used yet this
 * session (falling back to any image, including the account's current
 * avatar, once every image has been used at least once). Returns null if
 * the folder has no images at all. When `uid` is given, an image whose
 * filename (sans extension) exactly matches the UID — e.g. `123456.jpg` —
 * is preferred over a random pick, so a folder that mixes per-account
 * portraits with generic filler images still gives each account its own
 * intended photo first.
 */
export function pickRandomUnusedImage(
  folderPath: string,
  currentAvatarPath?: string | null,
  uid?: string | null
): string | null {
  const all = listImages(folderPath)
  if (all.length === 0) return null

  if (uid) {
    const matched = all.find((p) => basename(p, pathExtname(p)) === uid)
    if (matched) return matched
  }

  let used = usedByFolder.get(folderPath)
  if (!used) {
    used = new Set()
    usedByFolder.set(folderPath, used)
  }

  let candidates = all.filter((p) => !used!.has(p) && p !== currentAvatarPath)
  if (candidates.length === 0) {
    // Everything's been used (or the folder only has the current avatar) —
    // reset and allow repeats rather than failing the batch.
    used.clear()
    candidates = all.filter((p) => p !== currentAvatarPath)
    if (candidates.length === 0) candidates = all
  }

  const choice = candidates[Math.floor(Math.random() * candidates.length)]
  used.add(choice)
  return choice
}
