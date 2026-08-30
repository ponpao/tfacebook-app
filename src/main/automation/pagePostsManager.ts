// ---------------------------------------------------------------------------
// pagePostsManager.ts  — High-speed Facebook Page Post extraction & bulk deletion
// via Meta Business Suite table.
// ---------------------------------------------------------------------------
import type { Page } from 'playwright'
import type { Account, ManagedPage, PagePost, PagePostFilter } from '../../types/account'
import { launchContext, trackContext, untrackContext, closeAllTrackedContexts } from './browserContext'
import * as accountsRepo from '../db/accountsRepo'

let activeAbortController: AbortController | null = null

export function getOrCreatePageAbortSignal(): AbortSignal {
  if (!activeAbortController || activeAbortController.signal.aborted) {
    activeAbortController = new AbortController()
  }
  return activeAbortController.signal
}

export async function stopPageOperations(): Promise<{ ok: boolean }> {
  if (activeAbortController) {
    activeAbortController.abort()
    activeAbortController = null
  }
  await closeAllTrackedContexts().catch(() => void 0)
  return { ok: true }
}

function parseFbDate(str: string, defaultYear = new Date().getFullYear()): Date | null {
  if (!str) return null
  const lower = str.toLowerCase().trim()
  const now = new Date()

  // Relative dates: "just now", "5 mins ago", "2 hours ago"
  if (lower.includes('just now') || lower.includes('min') || lower.includes('hour')) {
    return now
  }
  // "yesterday"
  if (lower.includes('yesterday')) {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d
  }

  // Explicit Year if present in string (e.g., "Jun 26, 2025" or "2026")
  const yearMatch = str.match(/\b(202[0-9])\b/)
  const year = yearMatch ? parseInt(yearMatch[1], 10) : defaultYear

  const m = str.match(/(?:[A-Za-z]+,\s*)?([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d+):(\d+)(am|pm))?/i)
  if (!m) return null
  const monthName = m[1].slice(0, 3).toLowerCase()
  const day = parseInt(m[2], 10)
  let hour = m[3] ? parseInt(m[3], 10) : 0
  const min = m[4] ? parseInt(m[4], 10) : 0
  const ampm = m[5] ? m[5].toLowerCase() : ''
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0

  const months: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  }
  const month = months[monthName]
  if (month === undefined) return null
  return new Date(year, month, day, hour, min, 0)
}

/**
 * Configure fast route blocking to skip images, fonts, and media for maximum speed.
 */
async function setupSpeedRoutes(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType()
    if (['image', 'media', 'font'].includes(type)) {
      route.abort().catch(() => void 0)
    } else {
      route.continue().catch(() => void 0)
    }
  })
}

/**
 * Extract the list of managed pages for an account.
 */
export async function getOrExtractManagedPages(
  account: Account,
  forceRefresh = false,
  headless = true
): Promise<ManagedPage[]> {
  // If already saved in DB and not force refreshing, return parsed data
  if (!forceRefresh && account.pages_data?.trim()) {
    try {
      const parsed = JSON.parse(account.pages_data)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
    } catch {
      /* parse error, re-extract below */
    }
  }

  const trackKey = `extractpages:${account.id}`
  const context = await launchContext({ account, headless })
  trackContext(trackKey, context)

  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await setupSpeedRoutes(page)

    await page.goto('https://web.facebook.com/pages/?category=your_pages', {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    })
    await page.waitForTimeout(2500)

    // If redirected to login or checkpoint, account has no active page session
    const currentUrl = page.url()
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint') || currentUrl.includes('/recover')) {
      accountsRepo.updateAccount(account.id, { pages_count: 0, pages_data: JSON.stringify([]) })
      return []
    }

    const pages: ManagedPage[] = await page.evaluate((ownUid) => {
      const main = document.querySelector('div[role="main"]') || document.body
      const mainText = ((main as HTMLElement).innerText || '').replace(/\u00a0/g, ' ')

      // Check if user has any managed pages on this screen
      const hasManagedSection =
        /Pages you manage/i.test(mainText) ||
        /Your Pages/i.test(mainText) ||
        /Pages and profiles you manage/i.test(mainText) ||
        /Switch into/i.test(mainText) ||
        /Meta Business Suite/i.test(mainText)

      if (!hasManagedSection && /You don't manage any Pages|Create a Page|Discover|Followed Pages/i.test(mainText)) {
        return []
      }

      const allLinks = Array.from(main.querySelectorAll('a'))
      const list: ManagedPage[] = []

      const SYSTEM_KEYWORDS = [
        'login', 'messenger', 'facebook lite', 'lite', 'video', 'watch', 'privacy',
        'policy', 'center', 'about', 'create ad', 'ad_campaign', 'careers', 'cookies',
        'ad choices', 'terms', 'help', 'contact', 'places', 'games', 'marketplace',
        'meta pay', 'meta store', 'meta quest', 'ray-ban', 'instagram', 'threads',
        'voting', 'services', 'groups', 'developers', 'uploading', 'settings',
        'notifications', 'messages', 'invites', 'promote', 'followed pages', 'discover',
        'pages', 'create page', 'create post'
      ]

      const SYSTEM_HREFS = [
        '/login', '/recover', '/checkpoint', '/policies', '/privacy', '/terms',
        '/about', '/careers', '/cookies', '/help', '/ads', '/ad_center', '/ad_campaign',
        '/business', '/messenger', '/lite', '/watch', '/marketplace', '/gaming',
        '/fundraisers', '/events', '/saved', '/groups', '/friends', '/notifications',
        '/messages', '/settings', 'category=', '1.php'
      ]

      const pageLinks = allLinks.filter((a) => {
        const aText = (a.innerText || '').trim().toLowerCase()
        const href = (a.href || '').toLowerCase()
        if (!aText || aText.length > 80) return false
        if (SYSTEM_KEYWORDS.some((kw) => aText === kw || aText.startsWith(kw))) return false
        if (SYSTEM_HREFS.some((sh) => href.includes(sh))) return false
        return true
      })

      const bizLink = allLinks.find((a) => a.href.includes('asset_id=') || a.href.includes('page_id='))
      let defaultAssetId: string | undefined
      if (bizLink) {
        const m = bizLink.href.match(/(?:asset_id|page_id)=(\d+)/)
        if (m) defaultAssetId = m[1]
      }

      for (const a of pageLinks) {
        const name = (a.innerText || '').trim()
        let pageId = ''
        const m = a.href.match(/profile\.php\?id=(\d+)/)
        if (m) {
          pageId = m[1]
        } else {
          const clean = a.href.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '')
          if (clean && !SYSTEM_HREFS.some((sh) => clean.includes(sh))) {
            pageId = clean
          }
        }

        // Avoid adding the account's own user profile
        if (pageId && pageId !== ownUid && !list.some((p) => p.pageId === pageId)) {
          list.push({
            pageId,
            name,
            assetId: defaultAssetId || pageId,
            url: a.href.split('&')[0]
          })
        }
      }

      return list
    }, account.uid || '')

    // Update database (save accurate count and pages array, even if 0)
    accountsRepo.updateAccount(account.id, {
      pages_count: pages.length,
      pages_data: JSON.stringify(pages)
    })

    return pages
  } catch (err) {
    console.warn('[getOrExtractManagedPages] error:', err)
    return []
  } finally {
    untrackContext(trackKey)
    await context.close().catch(() => void 0)
  }
}

/**
 * Clear stored page data from the database for given accounts.
 */
export function clearStoredPageData(accountIds: number[]): { clearedCount: number } {
  let clearedCount = 0
  for (const id of accountIds) {
    accountsRepo.updateAccount(id, {
      pages_count: 0,
      pages_data: JSON.stringify([])
    })
    clearedCount += 1
  }
  return { clearedCount }
}

/**
 * Batch scan pages for multiple accounts with real-time progress callbacks.
 */
export async function batchScanPages(
  accountIds: number[],
  onProgress?: (event: { index: number; total: number; accountId: number; name: string; count: number }) => void
): Promise<{ totalScanned: number; totalPagesFound: number }> {
  let totalPagesFound = 0

  for (let i = 0; i < accountIds.length; i++) {
    const accId = accountIds[i]
    const acc = accountsRepo.getAccount(accId)
    if (!acc) continue

    const pages = await getOrExtractManagedPages(acc, true, true)
    totalPagesFound += pages.length

    onProgress?.({
      index: i + 1,
      total: accountIds.length,
      accountId: acc.id,
      name: acc.name || acc.uid || `Account #${acc.id}`,
      count: pages.length
    })
  }

  return { totalScanned: accountIds.length, totalPagesFound }
}

/**
 * Fetch published posts for a given page asset via Meta Business Suite table.
 */
export async function fetchPagePosts(
  account: Account,
  assetId: string,
  filter: PagePostFilter = {},
  headless = true,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void
): Promise<{ posts: PagePost[]; totalScraped: number }> {
  const trackKey = `fetchposts:${account.id}:${assetId}`
  const context = await launchContext({ account, headless })
  trackContext(trackKey, context)

  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await setupSpeedRoutes(page)

    onProgress?.('Opening Meta Business Suite...')
    const bizUrl = `https://business.facebook.com/latest/posts/published_posts?asset_id=${assetId}`
    await page.goto(bizUrl, { waitUntil: 'domcontentloaded', timeout: 35000 })
    await page.waitForTimeout(4000)

    // Remove any tour overlay or modal
    await page.evaluate(() => {
      document
        .querySelectorAll('[data-surface*="GeoTour"], div[role="dialog"]')
        .forEach((el) => el.remove())
    }).catch(() => void 0)
    await page.waitForTimeout(1000)

    // Hover over table to activate Virtual Grid
    const table = page.locator('table, div[role="grid"]').first()
    if (await table.isVisible({ timeout: 5000 }).catch(() => false)) {
      await table.hover().catch(() => void 0)
    }

    const allPostsMap = new Map<string, PagePost>()
    const maxSteps = 25

    onProgress?.('Scanning and scrolling table...')
    for (let s = 0; s < maxSteps; s++) {
      if (signal?.aborted) break

      const currentBatch: PagePost[] = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('div[role="row"], tr'))
        const items: PagePost[] = []

        rows.forEach((r) => {
          const text = (r as HTMLElement).innerText || ''
          if (!text || text.includes('Date published') || text.includes('Export data')) return

          const checkbox = r.querySelector('input[type="checkbox"]')
          const ariaLabel = checkbox ? checkbox.getAttribute('aria-label') || '' : ''
          const idMatch = ariaLabel.match(/id\s+(\d+)/) || text.match(/(\d{15,20})/)
          const id = idMatch ? idMatch[1] : null
          if (!id) return

          let type: PagePost['type'] = 'Status'
          if (text.includes('Reel') || text.includes('0:07') || text.includes('0:14') || text.includes('0:11') || !!r.querySelector('img[src*="video"]')) {
            type = 'Reel'
          } else if (text.includes('Photo') || !!r.querySelector('img[src*="photo"]')) {
            type = 'Photo'
          }

          const dateMatch =
            text.match(
              /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s*\d{1,2}:\d{2}(?:am|pm))?/i
            ) || text.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i)
          const date = dateMatch ? dateMatch[0] : 'Unknown'

          // Metrics Parsing 100%
          const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
          const numLines = lines
            .filter((l) => /^\d[\d,]*$/.test(l))
            .map((l) => parseInt(l.replace(/,/g, ''), 10))
          const reach = numLines[0] !== undefined ? numLines[0] : 0
          const views = numLines[1] !== undefined ? numLines[1] : 0
          const likes = numLines[3] !== undefined ? numLines[3] : 0

          const title =
            lines.find(
              (l) =>
                l.length > 5 &&
                !l.includes('Reel') &&
                !l.includes('Photo') &&
                !l.includes('Boost') &&
                !l.includes('Jun') &&
                !l.includes('May')
            ) ||
            lines[0] ||
            'Post'

          items.push({
            id,
            type,
            date,
            title: title.slice(0, 100),
            reach,
            views,
            likes,
            status: 'Published'
          })
        })

        return items
      })

      currentBatch.forEach((item) => {
        if (!allPostsMap.has(item.id)) {
          allPostsMap.set(item.id, item)
        }
      })

      onProgress?.(`Loaded ${allPostsMap.size} posts...`)

      // Mouse Wheel Scroll down
      await page.mouse.wheel(0, 2500)
      await page.waitForTimeout(1000)
    }

    const allPosts = Array.from(allPostsMap.values())

    // Filter by Date Range and Type
    const fromObj = filter.fromDate ? new Date(`${filter.fromDate}T00:00:00`) : null
    const toObj = filter.toDate ? new Date(`${filter.toDate}T23:59:59`) : null
    const targetType = filter.targetType || 'ALL'

    const filtered = allPosts.filter((p) => {
      const pDate = parseFbDate(p.date)
      if (pDate) {
        if (fromObj && pDate < fromObj) return false
        if (toObj && pDate > toObj) return false
      }
      if (targetType !== 'ALL' && p.type.toUpperCase() !== targetType.toUpperCase()) {
        return false
      }
      return true
    })

    onProgress?.(`Found ${filtered.length} matching posts`)
    return { posts: filtered, totalScraped: allPosts.length }
  } catch (err) {
    console.warn('[fetchPagePosts] error:', err)
    return { posts: [], totalScraped: 0 }
  } finally {
    untrackContext(trackKey)
    await context.close().catch(() => void 0)
  }
}

export type DeleteProgressPayload = {
  message: string
  deletedCount?: number
  completedIds?: string[]
}

/**
 * Bulk delete posts in Meta Business Suite table.
 */
export async function bulkDeletePagePosts(
  account: Account,
  assetId: string,
  postIds: string[],
  headless = true,
  batchSize = 20,
  signal?: AbortSignal,
  onProgress?: (progress: DeleteProgressPayload | string) => void
): Promise<{ success: boolean; deletedCount: number; detail: string }> {
  if (postIds.length === 0) {
    return { success: true, deletedCount: 0, detail: 'No posts selected to delete' }
  }

  const trackKey = `deleteposts:${account.id}:${assetId}`
  const context = await launchContext({ account, headless })
  trackContext(trackKey, context)

  const effectiveBatchSize = Math.max(1, batchSize || 20)
  // Split post IDs into chunks of effectiveBatchSize
  const chunks: string[][] = []
  for (let i = 0; i < postIds.length; i += effectiveBatchSize) {
    chunks.push(postIds.slice(i, i + effectiveBatchSize))
  }

  let totalDeleted = 0

  try {
    const page = context.pages()[0] ?? (await context.newPage())
    if (headless) {
      await setupSpeedRoutes(page)
    }

    onProgress?.('Opening Meta Business Suite...')
    const bizUrl = `https://business.facebook.com/latest/posts/published_posts?asset_id=${assetId}`
    await page.goto(bizUrl, { waitUntil: 'domcontentloaded', timeout: 40000 })
    await page.waitForTimeout(3000)

    // Remove any tour overlay or modal
    await page.evaluate(() => {
      document.querySelectorAll('[data-surface*="GeoTour"]').forEach((el) => el.remove())
    }).catch(() => void 0)

    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      if (signal?.aborted) break
      const currentChunk = chunks[cIdx]
      onProgress?.(
        `Batch ${cIdx + 1}/${chunks.length}: Selecting ${currentChunk.length} post(s)...`
      )

      let checkedCount = 0

      for (const id of currentChunk) {
        if (signal?.aborted) break
        const cb = page.locator(`input[type="checkbox"][aria-label*="${id}"]`).first()
        if (await cb.isVisible({ timeout: 1200 }).catch(() => false)) {
          await cb.click({ force: true }).catch(() => void 0)
          checkedCount += 1
        }
      }

      if (checkedCount === 0) {
        // Fallback: evaluate select checkboxes with IDs
        checkedCount = await page.evaluate((ids) => {
          let count = 0
          const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
          checkboxes.forEach((cb) => {
            const aria = cb.getAttribute('aria-label') || ''
            if (ids.some((id) => aria.includes(id))) {
              ;(cb as HTMLElement).click()
              count += 1
            }
          })
          return count
        }, currentChunk).catch(() => 0)
      }

      if (checkedCount === 0) {
        console.warn(`[bulkDeletePagePosts] Batch ${cIdx + 1}: No checkboxes found for current chunk`)
        continue
      }

      await page.waitForTimeout(1000)

      onProgress?.(`Batch ${cIdx + 1}/${chunks.length}: Clicking Delete...`)
      const deleteBtn = page
        .locator('div[role="button"]:has-text("Delete"), button:has-text("Delete")')
        .first()

      if (await deleteBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        await deleteBtn.click({ force: true }).catch(() => void 0)
        await page.waitForTimeout(1800)

        onProgress?.(`Batch ${cIdx + 1}/${chunks.length}: Confirming Move to trash...`)

        // Look for the blue "Move to trash" button in the confirmation modal
        let confirmed = await page.evaluate(() => {
          const dialog = document.querySelector('div[role="dialog"]') || document.body
          const btns = Array.from(dialog.querySelectorAll('button, div[role="button"], [aria-label]'))
          const target = btns.find((b) => {
            const txt = (b.textContent || '').trim()
            const aria = (b.getAttribute('aria-label') || '').trim()
            return (
              /^Move to trash$/i.test(txt) ||
              /^Move to trash$/i.test(aria) ||
              txt.includes('Move to trash') ||
              aria.includes('Move to trash')
            )
          })
          if (target) {
            ;(target as HTMLElement).click()
            return true
          }
          return false
        }).catch(() => false)

        if (!confirmed) {
          const confirmBtn = page
            .locator(
              'div[role="dialog"] button:has-text("Move to trash"), div[role="dialog"] div[role="button"]:has-text("Move to trash"), [aria-label="Move to trash"]'
            )
            .first()
          if (await confirmBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
            await confirmBtn.click({ force: true }).catch(() => void 0)
            confirmed = true
          }
        }

        if (confirmed) {
          totalDeleted += currentChunk.length
          onProgress?.({
            message: `Deleted ${totalDeleted}/${postIds.length} posts (Batch ${cIdx + 1}/${chunks.length} complete)`,
            deletedCount: totalDeleted,
            completedIds: currentChunk
          })
          await page.waitForTimeout(2000)
        }
      }
    }

    return {
      success: totalDeleted > 0,
      deletedCount: totalDeleted,
      detail: `Successfully moved ${totalDeleted} post(s) to trash in ${chunks.length} batch(es)`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, deletedCount: totalDeleted, detail: `Error: ${msg}` }
  } finally {
    untrackContext(trackKey)
    await context.close().catch(() => void 0)
  }
}
