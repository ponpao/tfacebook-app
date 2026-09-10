// ---------------------------------------------------------------------------
// pageExtractorV2.ts — High-speed Facebook Pages Extractor V2
// Extracts: Count, Name, Page ID, Asset ID, Followers, Category, Website & Deactivated Pages
// 100% faithful to Note Get Page V2 (Standalone clean browser context & fresh cookie injection)
// ---------------------------------------------------------------------------
import { chromium } from 'playwright'
import { existsSync } from 'fs'
import type { Account, ManagedPage } from '../../types/account'
import * as accountsRepo from '../db/accountsRepo'
import { getAppSettings } from '../db/settingsRepo'
import { parseProxy } from './browserContext'

let v2AbortController: AbortController | null = null

export function getOrCreateV2AbortSignal(): AbortSignal {
  if (!v2AbortController || v2AbortController.signal.aborted) {
    v2AbortController = new AbortController()
  }
  return v2AbortController.signal
}

export function stopV2Extraction(): void {
  if (v2AbortController) {
    v2AbortController.abort()
    v2AbortController = null
  }
}

/**
 * Clean Unicode obfuscation characters injected by Facebook (\u034F, \u200B-\u200D, \uFEFF)
 */
export function cleanFbText(str: string | null | undefined): string {
  if (!str) return ''
  return str.replace(/[\u034F\u200B-\u200D\uFEFF]/g, '').trim()
}

/**
 * Parse raw Facebook cookie string into Playwright Cookie objects
 */
function parseCookies(cookieString: string, domain = '.facebook.com') {
  if (!cookieString) return []
  return cookieString.split(';').map((pair) => {
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
  }).filter(Boolean) as Array<{ name: string; value: string; domain: string; path: string; secure: boolean }>
}

export interface V2ScanProgressEvent {
  index: number
  total: number
  accountId: number
  uid: string
  name: string
  message: string
  pagesFound: number
}

/**
 * Extract Facebook Pages for a single account using V2 Engine.
 */
export async function extractSingleAccountPagesV2(
  account: Account,
  headless = true,
  signal?: AbortSignal,
  onStepProgress?: (msg: string) => void
): Promise<ManagedPage[]> {
  const cookieStr = account.cookie?.trim()
  if (!cookieStr && !account.uid) {
    onStepProgress?.('No cookie or UID available')
    return []
  }

  const settings = getAppSettings()
  const customPath = settings.customChromiumPath?.trim()
  const executablePath = customPath && existsSync(customPath) ? customPath : undefined
  const proxy = parseProxy(account.proxy)

  onStepProgress?.('Launching browser…')
  const browser = await chromium.launch({
    headless,
    executablePath,
    proxy: proxy
      ? {
          server: proxy.server,
          username: proxy.username,
          password: proxy.password
        }
      : undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-notifications'
    ]
  })

  try {
    const context = await browser.newContext({
      userAgent:
        account.user_agent?.trim() ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 950 }
    })

    if (cookieStr) {
      const parsedCookies = parseCookies(cookieStr)
      if (parsedCookies.length > 0) {
        await context.addCookies(parsedCookies)
      }
    }

    const page = await context.newPage()

    // Block images, fonts, media for maximum performance (5x-10x speed)
    await page.route('**/*', (route) => {
      const type = route.request().resourceType()
      if (['image', 'media', 'font'].includes(type)) {
        route.abort().catch(() => void 0)
      } else {
        route.continue().catch(() => void 0)
      }
    })

    onStepProgress?.('Opening Your Pages…')
    await page.goto('https://web.facebook.com/pages/?category=your_pages', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    })
    await page.waitForTimeout(3500)

    if (signal?.aborted) return []

    // Check for login / checkpoint / logout redirection
    const currentUrl = page.url()
    const isLoggedOut =
      currentUrl.includes('index.php') ||
      currentUrl.includes('/login') ||
      currentUrl.includes('/checkpoint') ||
      currentUrl.includes('/recover') ||
      currentUrl.includes('/reg')

    if (isLoggedOut) {
      onStepProgress?.('Session checkpointed or logged out')
      accountsRepo.updateAccount(account.id, { pages_count: 0, pages_data: JSON.stringify([]) })
      return []
    }

    // Extract Active Pages & Deactivated Pages
    onStepProgress?.('Parsing Active and Deactivated Pages…')
    const pagesData = await page.evaluate((ownUid) => {
      const clean = (s: string) => (s || '').replace(/[\u034F\u200B-\u200D\uFEFF]/g, '').trim()
      const main = document.querySelector('div[role="main"]') || document.body
      const fullText = clean((main as HTMLElement).innerText || '')

      const hasManagedSection =
        /Pages you manage/i.test(fullText) ||
        /Your Pages/i.test(fullText) ||
        /Pages and profiles you manage/i.test(fullText) ||
        /Deactivated and deleted Pages/i.test(fullText)

      if (!hasManagedSection) {
        return { activePages: [], deactivatedPages: [] }
      }

      const SYSTEM_KEYWORDS = [
        'login', 'messenger', 'facebook lite', 'lite', 'video', 'watch', 'privacy',
        'policy', 'center', 'about', 'create ad', 'ad_campaign', 'careers', 'cookies',
        'ad choices', 'terms', 'help', 'contact', 'places', 'games', 'marketplace',
        'meta pay', 'meta store', 'meta quest', 'ray-ban', 'instagram', 'threads',
        'voting', 'services', 'groups', 'developers', 'uploading', 'settings',
        'notifications', 'messages', 'invites', 'promote', 'followed pages', 'discover',
        'pages', 'create page', 'create post', 'switch into', 'switch profile', 'meta ai',
        'contact uploading', 'sign up', 'log in', 'forgot password'
      ]

      const SYSTEM_HREFS = [
        '/login', '/recover', '/checkpoint', '/policies', '/privacy', '/terms',
        '/about', '/careers', '/cookies', '/help', '/ads', '/ad_center', '/ad_campaign',
        '/business', '/messenger', '/lite', '/watch', '/marketplace', '/gaming',
        '/fundraisers', '/events', '/saved', '/groups', '/friends', '/notifications',
        '/messages', '/settings', 'category=', '1.php', 'meta.com', 'instagram.com',
        'threads.net', 'about.meta.com', 'help/', '/reg/', 'index.php'
      ]

      const activePages: Array<{ name: string; url: string; pageId: string; assetId: string }> = []
      const links = Array.from(main.querySelectorAll('a'))

      links.forEach((a) => {
        const href = a.href || ''
        const hrefLower = href.toLowerCase()
        const text = clean((a as HTMLElement).innerText || '')
        const textLower = text.toLowerCase()

        if (!text || text.length < 2 || text.length > 80 || text.includes('\n')) return
        if (SYSTEM_KEYWORDS.some((kw) => textLower === kw || textLower.startsWith(kw + ' ') || textLower.endsWith(' ' + kw))) return
        if (SYSTEM_HREFS.some((sh) => hrefLower.includes(sh))) return
        if (!href.includes('facebook.com/')) return

        let pageId = ''
        const idMatch = href.match(/id=(\d+)/)
        if (idMatch) {
          pageId = idMatch[1]
        } else {
          const cleanPath = href.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '')
          if (
            cleanPath &&
            !SYSTEM_HREFS.some((sh) => cleanPath.toLowerCase().includes(sh)) &&
            !SYSTEM_KEYWORDS.some((kw) => cleanPath.toLowerCase() === kw) &&
            !cleanPath.includes('.php')
          ) {
            pageId = cleanPath
          }
        }

        if (
          pageId &&
          pageId !== ownUid &&
          !SYSTEM_KEYWORDS.some((kw) => pageId.toLowerCase() === kw) &&
          !activePages.some((p) => p.pageId === pageId || p.name === text)
        ) {
          activePages.push({
            name: text,
            url: href.split('&')[0],
            pageId,
            assetId: ''
          })
        }

        if (href.includes('asset_id=')) {
          const m = href.match(/asset_id=(\d+)/)
          if (m && activePages.length > 0) {
            activePages[activePages.length - 1].assetId = m[1]
          }
        }
      })

      const deactivatedPages: string[] = []
      if (fullText.includes('Deactivated and deleted Pages')) {
        const lines = fullText.split('\n').map((l) => clean(l)).filter(Boolean)
        const startIndex = lines.findIndex((l) => l.includes('Deactivated and deleted Pages'))
        if (startIndex !== -1) {
          for (let i = startIndex + 1; i < lines.length; i++) {
            if (lines[i] === 'Activate' && i > 0) {
              const pageName = lines[i - 1]
              if (!pageName.includes('Activate these Pages') && !deactivatedPages.includes(pageName)) {
                deactivatedPages.push(pageName)
              }
            }
          }
        }
      }

      return { activePages, deactivatedPages }
    }, account.uid || '')

    const finalPages: ManagedPage[] = []
    const deactCount = pagesData.deactivatedPages.length

    // If there are no active pages, save summary record if deactivated pages exist
    if (pagesData.activePages.length === 0 && deactCount > 0) {
      finalPages.push({
        pageId: '',
        name: '',
        status: 'Summary',
        followers: '0',
        following: '0',
        category: '',
        website: '',
        deactivatedCount: deactCount
      })
    }

    // 2. Deep dive for each Active Page
    for (let i = 0; i < pagesData.activePages.length; i++) {
      if (signal?.aborted) break
      const item = pagesData.activePages[i]
      onStepProgress?.(`Gathering metrics for: "${item.name}" (${i + 1}/${pagesData.activePages.length})…`)

      let followers = '0'
      let following = '0'
      let category = 'Unspecified'
      let website = ''

      try {
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 35000 })
        await page.waitForTimeout(3000)

        const details = await page.evaluate(() => {
          const clean = (s: string) => (s || '').replace(/[\u034F\u200B-\u200D\uFEFF]/g, '').trim()
          const main = document.querySelector('div[role="main"]') || document.body
          const text = clean((main as HTMLElement).innerText || '')

          // Support 18K, 1.5M, 24k, 304, 1,234 followers/following
          let followerMatch = text.match(/([\d,.]+\s*[KkMmBb]?)\s*(?:followers?|អ្នកតាមដាន)/i)
          if (!followerMatch) {
            followerMatch = text.match(/([\d,.]+\s*[KkMmBb]?)\s*(?:likes?|ចូលចិត្ត)/i)
          }

          let followingMatch = text.match(/([\d,.]+\s*[KkMmBb]?)\s*(?:following|កំពុងតាមដាន)/i)

          // Direct element search fallback for follower count
          if (!followerMatch || !followingMatch) {
            const allElements = Array.from(main.querySelectorAll('a, span, div, strong'))
            for (const el of allElements) {
              const elText = clean((el as HTMLElement).innerText || '')
              if (!followerMatch) {
                const fm = elText.match(/^([\d,.]+\s*[KkMmBb]?)\s*(?:followers?|អ្នកតាមដាន|likes?)/i)
                if (fm) followerMatch = fm
              }
              if (!followingMatch) {
                const fngm = elText.match(/^([\d,.]+\s*[KkMmBb]?)\s*(?:following|កំពុងតាមដាន)/i)
                if (fngm) followingMatch = fngm
              }
              if (followerMatch && followingMatch) break
            }
          }

          let foundCat = 'Unspecified'
          const candidateCategories = [
            'Digital creator', 'Auto Service', 'Business center', 'Public figure',
            'Community', 'Shopping & retail', 'Product/service', 'E-commerce website',
            'Personal blog', 'Musician/band', 'News & media website', 'Government organization',
            'Education', 'Health/beauty', 'Media/news company', 'Entrepreneur', 'Artist',
            'Photographer', 'Blogger', 'Non-governmental organization (NGO)', 'Real Estate',
            'Restaurant', 'Coffee shop', 'Retail company', 'Clothing store', 'Advertising/marketing',
            'Finance', 'Medical & health', 'Travel company', 'Entertainment website', 'Interest'
          ]
          const allSpans = Array.from(main.querySelectorAll('span, div, a'))
          for (const el of allSpans) {
            const t = clean((el as HTMLElement).innerText || '')
            if (candidateCategories.some((cat) => t.toLowerCase() === cat.toLowerCase())) {
              foundCat = t
              break
            }
          }

          // Fallback: Check line immediately following followers
          if (foundCat === 'Unspecified') {
            const lines = text.split('\n').map((l) => clean(l)).filter(Boolean)
            const fIdx = lines.findIndex((l) => /followers?|អ្នកតាមដាន/i.test(l))
            if (fIdx !== -1 && lines[fIdx + 1] && lines[fIdx + 1].length < 45) {
              const candidate = lines[fIdx + 1]
              if (!/switch|manage|dashboard|insights|ad center|follow|search|like|message|create|posts|photos|reels/i.test(candidate)) {
                foundCat = candidate
              }
            }
          }

          const webLink = Array.from(main.querySelectorAll('a'))
            .map((a) => (a as HTMLAnchorElement).href)
            .find((h) => !h.includes('facebook.com') && h.startsWith('http')) || ''

          return {
            followers: followerMatch ? followerMatch[1].trim() : '0',
            following: followingMatch ? followingMatch[1].trim() : '0',
            category: foundCat,
            website: webLink
          }
        })

        followers = details.followers
        following = details.following
        category = details.category
        website = details.website
      } catch (err) {
        console.warn(`[extractSingleAccountPagesV2] Deep dive error for ${item.name}:`, err)
      }

      finalPages.push({
        pageId: item.pageId,
        name: item.name,
        assetId: item.assetId || item.pageId,
        url: item.url,
        followers,
        following,
        category,
        website,
        status: 'Active',
        deactivatedCount: deactCount
      })
    }

    accountsRepo.updateAccount(account.id, {
      pages_count: pagesData.activePages.length,
      pages_data: JSON.stringify(finalPages)
    })

    return finalPages
  } catch (error) {
    const err = error as Error
    console.error(`[extractSingleAccountPagesV2] Failed for Account #${account.id}:`, err.message)
    onStepProgress?.(`Error: ${err.message}`)
    return []
  } finally {
    await browser.close().catch(() => void 0)
  }
}

/**
 * Batch Scan multiple accounts using V2 Engine.
 */
export async function batchExtractPagesV2(
  accountIds: number[],
  headless = true,
  onProgress?: (event: V2ScanProgressEvent) => void
): Promise<{ totalScanned: number; totalPagesFound: number; results: Record<number, ManagedPage[]> }> {
  const signal = getOrCreateV2AbortSignal()
  let totalPagesFound = 0
  const results: Record<number, ManagedPage[]> = {}

  for (let i = 0; i < accountIds.length; i++) {
    if (signal.aborted) break

    const accId = accountIds[i]
    const acc = accountsRepo.getAccount(accId)
    if (!acc) continue

    onProgress?.({
      index: i + 1,
      total: accountIds.length,
      accountId: acc.id,
      uid: acc.uid || '',
      name: acc.name || '',
      message: `Starting scan for ${acc.name || acc.uid || '#' + acc.id}…`,
      pagesFound: totalPagesFound
    })

    const pages = await extractSingleAccountPagesV2(acc, headless, signal, (stepMsg) => {
      onProgress?.({
        index: i + 1,
        total: accountIds.length,
        accountId: acc.id,
        uid: acc.uid || '',
        name: acc.name || '',
        message: stepMsg,
        pagesFound: totalPagesFound
      })
    })

    totalPagesFound += pages.length
    results[acc.id] = pages

    onProgress?.({
      index: i + 1,
      total: accountIds.length,
      accountId: acc.id,
      uid: acc.uid || '',
      name: acc.name || '',
      message: `Completed: Found ${pages.length} page(s)`,
      pagesFound: totalPagesFound
    })
  }

  return {
    totalScanned: Object.keys(results).length,
    totalPagesFound,
    results
  }
}
