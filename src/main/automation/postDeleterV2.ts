/**
 * ============================================================================
 * FACEBOOK POST & REEL DELETER V2 (postDeleterV2.ts)
 * ស្រង់ទាញយក និងលុប Posts (Reels, Videos, Photos, Status) តាម Facebook Internal GraphQL API
 * Endpoint: https://web.facebook.com/api/graphql/ (useCometTrashPostMutation)
 * ============================================================================
 */

import { type BrowserContext, type Page } from 'playwright'
import type { Account, PagePost } from '../../types/account'
import { launchContext, trackContext, untrackContext, getTrackedContext } from './browserContext'

// Cancellation flag
let isAborted = false

export function stopDeletePostsV2(): { ok: boolean } {
  isAborted = true
  return { ok: true }
}

/**
 * Unicode obfuscation cleaner for Facebook texts
 */
function cleanFbText(str: string): string {
  if (!str) return ''
  return str.replace(/[\u034F\u200B-\u200D\uFEFF]/g, '').trim()
}

/**
 * Cookie string parser for Playwright
 */
function parseCookies(cookieString: string, domain = '.facebook.com') {
  if (!cookieString) return []
  return cookieString
    .split(';')
    .map((pair) => {
      const trimmed = pair.trim()
      const idx = trimmed.indexOf('=')
      if (idx === -1) return null
      const name = trimmed.substring(0, idx).trim()
      const value = trimmed.substring(idx + 1).trim()
      if (!name || !value) return null
      return {
        name,
        value,
        domain,
        path: '/',
        secure: true
      }
    })
    .filter(Boolean) as Array<{ name: string; value: string; domain: string; path: string; secure: boolean }>
}

/**
 * Build GraphQL Story ID from Reel ID or Post ID
 * Formula from verified testing:
 * - Reel / Video: S:_I<pageId>:VK:<itemId> (base64)
 * - Feed Post / Photo: S:_I<pageId>:<itemId>:<itemId> (base64)
 */
export function buildStoryId(pageId: string, itemId: string, type: 'reel' | 'video' | 'post' | 'photo' = 'reel'): string {
  if (type === 'reel' || type === 'video') {
    return Buffer.from(`S:_I${pageId}:VK:${itemId}`).toString('base64')
  } else {
    return Buffer.from(`S:_I${pageId}:${itemId}:${itemId}`).toString('base64')
  }
}

/**
 * Setup route aborting for speed (block images, fonts, media)
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
 * Fetch posts for a page using V2 method (Reels, Videos, Timeline posts)
 */
export async function fetchPagePostsV2(
  account: Account,
  pageId: string,
  filter: { fromDate?: string; toDate?: string; targetType?: string } = {},
  headless = true,
  onProgress?: (message: string) => void
): Promise<{ posts: PagePost[]; totalScraped: number }> {
  isAborted = false
  if (!account.cookie) {
    throw new Error('Account has no cookie')
  }

  const postsMap = new Map<string, PagePost>()

  const profileKey = `profile:${account.uid ?? account.id}`
  const trackKey = `deleterv2_fetch:${account.uid ?? account.id}`

  let context = getTrackedContext(profileKey)
  const isReused = Boolean(context)

  if (!context) {
    onProgress?.('Launching browser with profile for V2 post extraction…')
    context = await launchContext({ account, headless })
    trackContext(trackKey, context)
  } else {
    onProgress?.('Using existing active browser profile for V2 post extraction…')
  }

  const page = context.pages()[0] ?? (await context.newPage())
  await setupSpeedRoutes(page)

  try {
    const targetType = (filter.targetType || 'ALL').toUpperCase()

    // 1. Scan Reels tab if ALL or REEL
    if (targetType === 'ALL' || targetType === 'REEL') {
      onProgress?.('Scanning Reels tab…')
      try {
        await page.goto(`https://www.facebook.com/profile.php?id=${pageId}&sk=reels_tab`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        })
        await page.waitForTimeout(3500)

        // Check if session is logged out / expired
        const isLoggedOut = await page.evaluate(() => {
          const text = document.body.innerText || ''
          const url = window.location.href
          return url.includes('/login') || text.includes("This content isn't available right now")
        })
        if (isLoggedOut) {
          throw new Error(
            '⚠️ Cookie របស់គណនីនេះបានផុតកំណត់ (Session Expired)! សូមចុច "បើក Browser" (Open Browser) លើគណនីនេះក្នុងតារាងធំ ដើម្បី Login/Sync Cookie ថ្មី រួចចុចទាញម្តងទៀត!'
          )
        }

        // Switch into Page if switch button is visible
        const switchBanner = page
          .locator('div[role="button"]:has-text("Switch"), button:has-text("Switch")')
          .first()
        if (await switchBanner.isVisible({ timeout: 3000 }).catch(() => false)) {
          await switchBanner.click({ force: true }).catch(() => void 0)
          await page.waitForTimeout(2000)
          const dialogSwitch = page
            .locator('div[role="dialog"] div[role="button"]:has-text("Switch"), div[role="dialog"] button:has-text("Switch")')
            .first()
          if (await dialogSwitch.isVisible({ timeout: 3000 }).catch(() => false)) {
            await dialogSwitch.click({ force: true }).catch(() => void 0)
            await page.waitForTimeout(5000)
            await page.goto(`https://www.facebook.com/profile.php?id=${pageId}&sk=reels_tab`, {
              waitUntil: 'domcontentloaded',
              timeout: 35000
            })
            await page.waitForTimeout(3000)
          }
        }

        let noNewCount = 0
        let lastCount = 0
        const maxScrolls = 80 // Scans hundreds of reels until fully loaded

        for (let s = 0; s < maxScrolls; s++) {
          if (isAborted) break
          const items = await page.evaluate(() => {
            const allA = Array.from(document.querySelectorAll('a[href*="/reel/"]'))
            return allA
              .map((a) => {
                const href = (a as HTMLAnchorElement).href.split('?')[0]
                const text = ((a as HTMLElement).innerText || '').trim()
                const aria = a.getAttribute('aria-label') || ''
                return { href, text, aria }
              })
              .filter((r) => r.href.includes('/reel/') && !r.href.includes('/reel/?s='))
          })

          items.forEach((r) => {
            const match = r.href.match(/reel\/(\d+)/)
            if (match) {
              const reelId = match[1]
              if (!postsMap.has(reelId)) {
                postsMap.set(reelId, {
                  id: reelId,
                  type: 'Reel',
                  date: new Date().toLocaleDateString('en-US'),
                  title: cleanFbText(r.text) || cleanFbText(r.aria) || `Reel #${reelId}`,
                  views: 0,
                  likes: 0,
                  reach: 0,
                  status: 'Published'
                })
              }
            }
          })

          onProgress?.(`Found ${postsMap.size} reels… (scrolling ${s + 1})`)

          if (postsMap.size === lastCount) {
            noNewCount++
            if (noNewCount >= 4) break // End of content reached
          } else {
            noNewCount = 0
            lastCount = postsMap.size
          }

          await page.evaluate(() => window.scrollBy(0, 2500))
          await page.waitForTimeout(1100)
        }
      } catch (err) {
        console.warn('[postDeleterV2] Error scanning Reels tab:', err)
      }
    }

    // 2. Scan Videos tab if ALL or VIDEO
    if (targetType === 'ALL' || targetType === 'VIDEO') {
      onProgress?.('Scanning Videos tab…')
      try {
        await page.goto(`https://www.facebook.com/profile.php?id=${pageId}&sk=videos`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        })
        await page.waitForTimeout(3000)

        let noNewCount = 0
        let lastCount = postsMap.size
        const maxScrolls = 60

        for (let s = 0; s < maxScrolls; s++) {
          if (isAborted) break
          const items = await page.evaluate(() => {
            const allA = Array.from(
              document.querySelectorAll('a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch/"]')
            )
            return allA
              .map((a) => {
                const href = (a as HTMLAnchorElement).href.split('?')[0]
                const text = ((a as HTMLElement).innerText || '').trim()
                const aria = a.getAttribute('aria-label') || ''
                return { href, text, aria }
              })
              .filter((r) => !r.href.includes('/videos/?') && !r.href.includes('tab'))
          })

          items.forEach((v) => {
            const match = v.href.match(/(?:videos|reel)\/(\d+)/)
            if (match) {
              const vidId = match[1]
              if (!postsMap.has(vidId)) {
                const isReel = v.href.includes('/reel/')
                postsMap.set(vidId, {
                  id: vidId,
                  type: isReel ? 'Reel' : 'Status',
                  date: new Date().toLocaleDateString('en-US'),
                  title: cleanFbText(v.text) || cleanFbText(v.aria) || `Video #${vidId}`,
                  views: 0,
                  likes: 0,
                  reach: 0,
                  status: 'Published'
                })
              }
            }
          })

          onProgress?.(`Found ${postsMap.size} videos & reels… (scrolling ${s + 1})`)

          if (postsMap.size === lastCount) {
            noNewCount++
            if (noNewCount >= 4) break
          } else {
            noNewCount = 0
            lastCount = postsMap.size
          }

          await page.evaluate(() => window.scrollBy(0, 2500))
          await page.waitForTimeout(1100)
        }
      } catch (err) {
        console.warn('[postDeleterV2] Error scanning Videos tab:', err)
      }
    }

    // 3. Scan Photos tab if ALL or PHOTO
    if (targetType === 'ALL' || targetType === 'PHOTO') {
      onProgress?.('Scanning Photos tab…')
      try {
        await page.goto(`https://www.facebook.com/profile.php?id=${pageId}&sk=photos`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        })
        await page.waitForTimeout(3500)

        let noNewPhotos = 0
        let lastPhotoCount = postsMap.size
        const maxPhotoScrolls = 60

        for (let s = 0; s < maxPhotoScrolls; s++) {
          if (isAborted) break
          const photoItems = await page.evaluate(() => {
            const results: Array<{ fbid: string; href: string; title: string }> = []
            const allA = Array.from(document.querySelectorAll('a'))
            allA.forEach((a) => {
              const href = (a as HTMLAnchorElement).href || ''
              const m = href.match(/(?:photo\.php\?fbid=|photo\/\?fbid=)(\d+)/)
              if (m) {
                const fbid = m[1]
                const aria = a.getAttribute('aria-label') || ''
                const text = ((a as HTMLElement).innerText || '').trim()
                results.push({
                  fbid,
                  href,
                  title: text || aria || `Photo #${fbid}`
                })
              }
            })
            return results
          })

          photoItems.forEach((p) => {
            if (!postsMap.has(p.fbid)) {
              postsMap.set(p.fbid, {
                id: p.fbid,
                type: 'Photo',
                date: new Date().toLocaleDateString('en-US'),
                title: cleanFbText(p.title),
                views: 0,
                likes: 0,
                reach: 0,
                status: 'Published'
              })
            }
          })

          onProgress?.(`Found ${postsMap.size} posts & photos… (Photos scroll ${s + 1})`)

          if (postsMap.size === lastPhotoCount) {
            noNewPhotos++
            if (noNewPhotos >= 4) break
          } else {
            noNewPhotos = 0
            lastPhotoCount = postsMap.size
          }

          await page.evaluate(() => window.scrollBy(0, 2500))
          await page.waitForTimeout(1000)
        }
      } catch (err) {
        console.warn('[postDeleterV2] Error scanning Photos tab:', err)
      }
    }

    // 4. Scan Timeline for Posts and Status if ALL, STATUS, or PHOTO
    if (targetType === 'ALL' || targetType === 'STATUS' || targetType === 'PHOTO') {
      onProgress?.('Scanning Page Timeline…')
      try {
        await page.goto(`https://www.facebook.com/profile.php?id=${pageId}`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        })
        await page.waitForTimeout(3500)

        // Check and click Switch button if available
        const switchBtn = page
          .locator(
            'div[role="button"]:has-text("Switch"), button:has-text("Switch"), div[role="button"]:has-text("Switch Now"), button:has-text("Switch Now")'
          )
          .first()
        if (await switchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await switchBtn.click({ force: true }).catch(() => void 0)
          await page.waitForTimeout(2000)
          const dialogSwitch = page
            .locator('div[role="dialog"] div[role="button"]:has-text("Switch"), div[role="dialog"] button:has-text("Switch")')
            .first()
          if (await dialogSwitch.isVisible({ timeout: 3000 }).catch(() => false)) {
            await dialogSwitch.click({ force: true }).catch(() => void 0)
            await page.waitForTimeout(5000)
            await page.goto(`https://www.facebook.com/profile.php?id=${pageId}`, {
              waitUntil: 'domcontentloaded',
              timeout: 35000
            })
            await page.waitForTimeout(3000)
          }
        }

        let noNewTimeline = 0
        let lastTimelineCount = postsMap.size
        const maxScrolls = 60

        for (let s = 0; s < maxScrolls; s++) {
          if (isAborted) break
          const timelineItems = await page.evaluate(() => {
            const clean = (str: string) => (str || '').replace(/[\u034F\u200B-\u200D\uFEFF]/g, '').trim()
            const results: Array<{ href: string; id: string; type: string; title: string }> = []

            // 1. Extract from action buttons (feed status cards)
            const actionBtns = Array.from(document.querySelectorAll('div[aria-label*="Actions for this post"]'))
            actionBtns.forEach((btn, idx) => {
              let p: Element | null = btn
              let card: HTMLElement | null = null
              for (let i = 0; i < 20 && p; i++) {
                if (p.classList.contains('x1yztbdb') || p.getAttribute('role') === 'article') {
                  card = p as HTMLElement
                  break
                }
                p = p.parentElement
              }
              const cardText = card ? clean(card.innerText) : ''
              const validLines = cardText
                .split('\n')
                .map((l) => l.trim())
                .filter(
                  (l) =>
                    l.length > 2 &&
                    l !== 'Facebook' &&
                    !l.includes('comment') &&
                    !l.includes('Like') &&
                    !l.includes('Share')
                )
              const title = validLines.slice(0, 2).join(' - ')

              let itemId = ''
              if (card) {
                const links = Array.from(card.querySelectorAll('a')).map((a) => (a as HTMLAnchorElement).href || '')
                for (const l of links) {
                  const m = l.match(/(?:posts\/|story_fbid=|\/permalink\/)(pfbid[a-zA-Z0-9]+|\d+)/)
                  if (m) {
                    itemId = m[1]
                    break
                  }
                }
              }
              if (!itemId) {
                itemId = `status_${idx}_${validLines[0] ? validLines[0].slice(0, 15).replace(/\W+/g, '_') : idx}`
              }

              results.push({
                href: '',
                id: itemId,
                type: 'STATUS',
                title: title || `Status Post #${idx + 1}`
              })
            })

            // 2. Also check direct anchor links with permalinks or posts
            const allA = Array.from(document.querySelectorAll('a'))
            allA.forEach((a) => {
              const href = (a as HTMLAnchorElement).href || ''
              if (
                href.includes('/posts/') ||
                href.includes('/reel/') ||
                href.includes('permalink.php') ||
                href.includes('/permalink/') ||
                href.includes('photo.php?fbid=') ||
                href.includes('photo/?fbid=')
              ) {
                if (href.includes('sk=') || href.includes('category=') || href.includes('followers')) return

                let itemId = ''
                let type = 'STATUS'
                const mPost = href.match(/posts\/(pfbid[a-zA-Z0-9]+|\d+)/)
                const mPermalink = href.match(/(?:permalink\.php\?story_fbid=|\/permalink\/)(pfbid[a-zA-Z0-9]+|\d+)/)
                const mReel = href.match(/reel\/(\d+)/)
                const mPhoto = href.match(/(?:photo\/\?fbid=|photo\.php\?fbid=|photo\/)(\d+)/)

                if (mReel) {
                  itemId = mReel[1]
                  type = 'REEL'
                } else if (mPhoto) {
                  itemId = mPhoto[1]
                  type = 'PHOTO'
                } else if (mPost) {
                  itemId = mPost[1]
                  type = 'STATUS'
                } else if (mPermalink) {
                  itemId = mPermalink[1]
                  type = 'STATUS'
                }

                if (itemId && !results.some((r) => r.id === itemId)) {
                  let p = a.parentElement
                  let container: HTMLElement | null = null
                  for (let k = 0; k < 8 && p; k++) {
                    if (p.getAttribute('role') === 'article' || p.classList.contains('x1yztbdb')) {
                      container = p as HTMLElement
                      break
                    }
                    p = p.parentElement
                  }

                  const title = container ? clean(container.innerText).split('\n')[0] : clean(a.innerText)
                  results.push({
                    href: href.split('?__cft__')[0],
                    id: itemId,
                    type,
                    title: title || `Post #${itemId}`
                  })
                }
              }
            })
            return results
          })

          timelineItems.forEach((item) => {
            if (!postsMap.has(item.id)) {
              const mappedType: 'Reel' | 'Photo' | 'Status' =
                item.type === 'REEL' ? 'Reel' : item.type === 'PHOTO' ? 'Photo' : 'Status'
              postsMap.set(item.id, {
                id: item.id,
                type: mappedType,
                date: new Date().toLocaleDateString('en-US'),
                title: item.title,
                views: 0,
                likes: 0,
                reach: 0,
                status: 'Published'
              })
            }
          })

          onProgress?.(`Found ${postsMap.size} posts, reels & photos… (Timeline scroll ${s + 1})`)

          if (postsMap.size === lastTimelineCount) {
            noNewTimeline++
            if (noNewTimeline >= 4) break
          } else {
            noNewTimeline = 0
            lastTimelineCount = postsMap.size
          }

          await page.keyboard.press('PageDown')
          await page.waitForTimeout(600)
          await page.evaluate(() => window.scrollBy(0, 2200))
          await page.waitForTimeout(1000)
        }
      } catch (err) {
        console.warn('[postDeleterV2] Error scanning Timeline:', err)
      }
    }

    const posts = Array.from(postsMap.values())
    onProgress?.(`V2 Extraction completed: Found ${posts.length} item(s)`)
    return {
      posts,
      totalScraped: posts.length
    }
  } finally {
    if (!isReused && context) {
      untrackContext(trackKey)
      await context.close().catch(() => void 0)
    }
  }
}

/**
 * Bulk Delete Posts via Facebook Internal GraphQL API (useCometTrashPostMutation)
 */
export async function deletePagePostsV2(
  account: Account,
  pageId: string,
  postItems: Array<{ id: string; type: string }>,
  headless = true,
  threads = 3,
  onProgress?: (progress: {
    message: string
    deletedCount?: number
    completedIds?: string[]
    currentBatchIds?: string[]
  }) => void
): Promise<{ success: boolean; deletedCount: number; detail: string }> {
  isAborted = false
  if (!account.cookie) {
    return { success: false, deletedCount: 0, detail: 'Account has no cookie' }
  }

  if (postItems.length === 0) {
    return { success: true, deletedCount: 0, detail: 'No posts to delete' }
  }

  const profileKey = `profile:${account.uid ?? account.id}`
  const trackKey = `deleterv2_del:${account.uid ?? account.id}`

  let context = getTrackedContext(profileKey)
  const isReused = Boolean(context)

  if (!context) {
    onProgress?.({ message: 'Initializing browser with profile for V2 deletion…' })
    context = await launchContext({ account, headless })
    trackContext(trackKey, context)
  } else {
    onProgress?.({ message: 'Using active browser profile for V2 deletion…' })
  }

  const page = context.pages()[0] ?? (await context.newPage())
  let deletedCount = 0
  const completedIds: string[] = []

  try {
    onProgress?.({ message: `Navigating to Page (ID: ${pageId}) to retrieve security tokens…` })
    await page.goto(`https://web.facebook.com/profile.php?id=${pageId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    })
    await page.waitForTimeout(4000)

    // Check and click Switch button to switch into Page
    const switchBanner = page
      .locator(
        'div[role="button"]:has-text("Switch"), button:has-text("Switch"), div[role="button"]:has-text("Switch Now"), button:has-text("Switch Now")'
      )
      .first()
    if (await switchBanner.isVisible({ timeout: 4000 }).catch(() => false)) {
      onProgress?.({ message: 'Clicking Switch into Page…' })
      await switchBanner.click({ force: true }).catch(() => void 0)
      await page.waitForTimeout(2000)

      const dialogSwitch = page
        .locator(
          'div[role="dialog"] div[role="button"]:has-text("Switch"), div[role="dialog"] button:has-text("Switch")'
        )
        .first()
      if (await dialogSwitch.isVisible({ timeout: 4000 }).catch(() => false)) {
        onProgress?.({ message: 'Confirming Profile Switch…' })
        await dialogSwitch.click({ force: true }).catch(() => void 0)
        await page.waitForTimeout(6000)
      }
    }

    // Extract fb_dtsg and actorId tokens
    const tokens = await page.evaluate(() => {
      let dtsg: string | null = null
      let actorId: string | null = null
      const scripts = Array.from(document.querySelectorAll('script'))
      for (const s of scripts) {
        const c = s.textContent || ''
        if (!dtsg) {
          const m = c.match(/"DTSGInitialData",\[\],{"token":"([^"]+)"/) || c.match(/"token":"([^"]+)"/)
          if (m) dtsg = m[1]
        }
        if (!actorId) {
          const m = c.match(/"actorID":"(\d+)"/) || c.match(/"USER_ID":"(\d+)"/)
          if (m) actorId = m[1]
        }
      }
      return { dtsg, actorId }
    })

    if (!tokens.dtsg) {
      return {
        success: false,
        deletedCount: 0,
        detail: 'Could not extract fb_dtsg token from Facebook page'
      }
    }

    const effectiveActorId = tokens.actorId || pageId

    const effectiveThreads = Math.max(1, Math.min(threads || 3, 10))
    // Divide postItems into chunks of effectiveThreads
    const chunks: Array<Array<{ id: string; type: string }>> = []
    for (let i = 0; i < postItems.length; i += effectiveThreads) {
      chunks.push(postItems.slice(i, i + effectiveThreads))
    }

    // Loop through chunks concurrently
    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      if (isAborted) {
        onProgress?.({ message: 'Operation stopped by user' })
        break
      }

      const chunk = chunks[cIdx]
      const currentBatchIds = chunk.map((c) => c.id)

      // Separate items in chunk: Photos, Status posts, and Reels/Videos
      const reelsAndVideos = chunk.filter((c) => {
        const t = (c.type || '').toLowerCase()
        return t.includes('reel') || t.includes('video')
      })
      const photos = chunk.filter((c) => (c.type || '').toLowerCase().includes('photo'))
      const statuses = chunk.filter((c) => {
        const t = (c.type || '').toLowerCase()
        return t.includes('status') || (!t.includes('reel') && !t.includes('video') && !t.includes('photo'))
      })

      // 1. Delete Reels & Videos via fast GraphQL Mutation (concurrent)
      if (reelsAndVideos.length > 0) {
        const chunkWithStories = reelsAndVideos.map((item) => {
          const storyType = item.type.toLowerCase().includes('reel') ? 'reel' : 'video'
          const storyId = buildStoryId(pageId, item.id, storyType)
          return { id: item.id, type: item.type, storyId }
        })

        const batchResults = await page.evaluate(
          async ({ items, dtsgToken, actor, baseIndex }) => {
            const promises = items.map(async (item, idx) => {
              try {
                const params = new URLSearchParams()
                params.append('av', actor)
                params.append('__user', actor)
                params.append('__a', '1')
                params.append('__comet_req', '15')
                params.append('fb_dtsg', dtsgToken)
                params.append('fb_api_caller_class', 'RelayModern')
                params.append('fb_api_req_friendly_name', 'useCometTrashPostMutation')
                params.append('server_timestamps', 'true')
                params.append('doc_id', '26146132388368957')
                params.append(
                  'variables',
                  JSON.stringify({
                    input: {
                      story_id: item.storyId,
                      story_location: 'TIMELINE',
                      actor_id: actor,
                      client_mutation_id: String(baseIndex + idx + 1)
                    }
                  })
                )

                const response = await fetch('/api/graphql/', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-FB-Friendly-Name': 'useCometTrashPostMutation'
                  },
                  body: params.toString()
                })

                const rawText = await response.text()
                const cleanText = rawText.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '')
                const json = JSON.parse(cleanText)
                const success = Boolean(json?.data?.move_to_trash_story?.success)
                return { id: item.id, type: item.type, success, json }
              } catch (err: any) {
                return { id: item.id, type: item.type, success: false, error: err.message }
              }
            })
            return await Promise.all(promises)
          },
          {
            items: chunkWithStories,
            dtsgToken: tokens.dtsg,
            actor: effectiveActorId,
            baseIndex: cIdx * effectiveThreads
          }
        )

        batchResults.forEach((res) => {
          if (res.success) {
            deletedCount++
            completedIds.push(res.id)
          }
        })
      }

      // 2. Delete Photos (opening photo and clicking Delete Photo)
      for (const photo of photos) {
        if (isAborted) break
        try {
          await page.goto(`https://www.facebook.com/photo.php?fbid=${photo.id}`, {
            waitUntil: 'domcontentloaded',
            timeout: 25000
          })
          await page.waitForTimeout(1500)
          // Look for 3-dots in photo viewer (side rail, not top navbar)
          const clickedDots = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('div[role="button"], button'))
            const railDots = btns.filter((b) => {
              const rect = b.getBoundingClientRect()
              const aria = b.getAttribute('aria-label') || ''
              const hasPopup = b.getAttribute('aria-haspopup')
              return (
                rect.top > 60 &&
                (aria.includes('Actions') ||
                  aria.includes('options') ||
                  aria.includes('More') ||
                  aria.includes('Photo') ||
                  hasPopup === 'menu')
              )
            })
            if (railDots.length > 0) {
              ;(railDots[0] as HTMLElement).click()
              return true
            }
            return false
          })
          if (!clickedDots) {
            const dots = page
              .locator(
                'div[aria-label="Actions for this post"], div[aria-label="Photo options"], div[aria-label="More options"], div[aria-label="Photo actions"]'
              )
              .last()
            if (await dots.isVisible({ timeout: 2000 }).catch(() => false)) {
              await dots.click({ force: true }).catch(() => void 0)
            }
          }
          await page.waitForTimeout(800)

          // Click 'Delete photo'
          const clickedDel = await page.evaluate(() => {
            const clean = (s: string) => (s || '').replace(/[\u034F\u200B-\u200D\uFEFF]/g, '').trim()
            const items = Array.from(
              document.querySelectorAll('div[role="menuitem"], div[role="menu"] div[role="button"], div[role="menu"] span')
            )
            const target = items.find((it) => {
              const txt = clean((it as HTMLElement).innerText).toLowerCase()
              return txt.includes('delete photo') || txt === 'delete'
            })
            if (target) {
              ;(target as HTMLElement).click()
              return true
            }
            return false
          })
          if (!clickedDel) {
            const delItem = page
              .locator('div[role="menuitem"]:has-text("Delete photo"), div[role="menuitem"]:has-text("Delete")')
              .first()
            if (await delItem.isVisible({ timeout: 2000 }).catch(() => false)) {
              await delItem.click({ force: true }).catch(() => void 0)
            }
          }
          await page.waitForTimeout(800)

          // Confirm Delete in dialog
          const clickedConfirm = await page.evaluate(() => {
            const clean = (s: string) => (s || '').replace(/[\u034F\u200B-\u200D\uFEFF]/g, '').trim()
            const d = document.querySelector('div[role="dialog"]')
            if (!d) return false
            const btns = Array.from(d.querySelectorAll('div[role="button"], button'))
            const confirm = btns.find((b) => {
              const txt = clean((b as HTMLElement).innerText).toLowerCase()
              const aria = ((b as HTMLElement).getAttribute('aria-label') || '').toLowerCase()
              return txt === 'delete' || aria === 'delete'
            })
            if (confirm) {
              ;(confirm as HTMLElement).click()
              return true
            }
            return false
          })
          if (!clickedConfirm) {
            const confirmBtn = page
              .locator(
                'div[role="dialog"] div[role="button"]:has-text("Delete"), div[role="dialog"] button:has-text("Delete")'
              )
              .first()
            if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await confirmBtn.click({ force: true }).catch(() => void 0)
            }
          }
          await page.waitForTimeout(2000)
          deletedCount++
          completedIds.push(photo.id)
          onProgress?.({
            message: `✓ Deleted Photo #${photo.id}`,
            deletedCount,
            completedIds
          })
        } catch (pErr) {
          console.warn(`[postDeleterV2] Error deleting photo ${photo.id}:`, pErr)
        }
      }

      // 3. Delete Status Posts (Move to trash on Timeline)
      for (const st of statuses) {
        if (isAborted) break
        try {
          if (!page.url().includes('facebook.com/profile.php')) {
            await page.goto(`https://www.facebook.com/profile.php?id=${pageId}`, {
              waitUntil: 'domcontentloaded',
              timeout: 30000
            })
            await page.waitForTimeout(2000)
          }
          const actionBtn = page.locator('div[aria-label*="Actions for this post"]').first()
          if (await actionBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
            await actionBtn.click({ force: true }).catch(() => void 0)
            await page.waitForTimeout(800)
            const trashItem = page.locator('div[role="menuitem"]:has-text("Move to trash")').first()
            if (await trashItem.isVisible({ timeout: 3000 }).catch(() => false)) {
              await trashItem.click({ force: true }).catch(() => void 0)
              await page.waitForTimeout(800)
              const moveConfirm = page
                .locator('div[role="dialog"] div[role="button"]:has-text("Move"), div[role="dialog"] button:has-text("Move")')
                .first()
              if (await moveConfirm.isVisible({ timeout: 3000 }).catch(() => false)) {
                await moveConfirm.click({ force: true }).catch(() => void 0)
                await page.waitForTimeout(2500)
              }
            }
          }
          deletedCount++
          completedIds.push(st.id)
          onProgress?.({
            message: `✓ Moved Status Post #${st.id} to trash`,
            deletedCount,
            completedIds
          })
        } catch (sErr) {
          console.warn(`[postDeleterV2] Error trashing status post ${st.id}:`, sErr)
        }
      }

      onProgress?.({
        message: `✓ Batch ${cIdx + 1}/${chunks.length} completed (Total Deleted: ${deletedCount}/${postItems.length})`,
        deletedCount,
        completedIds
      })

      // Short safety delay between batches
      await page.waitForTimeout(1000)
    }

    return {
      success: deletedCount > 0,
      deletedCount,
      detail: `Successfully moved ${deletedCount}/${postItems.length} post(s) to trash`
    }
  } catch (err: any) {
    return {
      success: false,
      deletedCount,
      detail: err.message || String(err)
    }
  } finally {
    if (!isReused && context) {
      untrackContext(trackKey)
      await context.close().catch(() => void 0)
    }
  }
}
