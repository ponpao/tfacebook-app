// ---------------------------------------------------------------------------
// avatarProtocol.ts  — registers the `avatar://` custom protocol so the
// renderer can load a downloaded avatar (or any other file under the
// configured Avatar Download Directory) as a plain <img src="avatar://{uid}">
// without relying on file:// behavior across origins, which Chromium's
// default security model doesn't reliably allow for a contextIsolated,
// file://-loaded renderer.
//
// registerAvatarProtocolScheme() must run before app.whenReady() (Electron
// requires privileged scheme registration at that point); registerAvatarProtocolHandler()
// runs after, once the app is ready.
// ---------------------------------------------------------------------------
import { protocol, net } from 'electron'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { getLocalAvatarPath } from './avatarService'

export const AVATAR_PROTOCOL = 'avatar'

/** Call before app.whenReady() — Electron only accepts privileged scheme registration at that point. */
export function registerAvatarProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: AVATAR_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/**
 * Call after app.whenReady(). Serves avatar://{uid}?v=... -> the uid's
 * local {avatarStoragePath}/{uid}.jpg if it exists, or a 404 otherwise (the
 * renderer falls back to a placeholder silhouette). The ?v= query param is
 * a pure cache-busting value (the account's updated_at) the renderer
 * appends — parsed via URL rather than a manual string replace so it's
 * correctly excluded from the uid regardless of scheme host-vs-pathname
 * quirks or future query params.
 *
 * getLocalAvatarPath() (avatarService.ts) resolves the CURRENT
 * avatarStoragePath from settings fresh on every call — not cached at
 * registration time — so a user changing the setting mid-session is
 * reflected on the very next avatar load, and (as of the fix in
 * browserContext.ts's avatarsRoot()) resolves a relative configured path
 * against userData rather than an unpredictable process.cwd(), which was
 * the actual root cause of avatars downloading successfully but then never
 * displaying: the download and the protocol-serve calls could each resolve
 * the same relative setting string to two different real directories.
 */
export function registerAvatarProtocolHandler(): void {
  protocol.handle(AVATAR_PROTOCOL, (request) => {
    const url = new URL(request.url)
    // A standard-privileged custom scheme parses "avatar://123456" with the
    // uid as the host, not the pathname (there's no path segment at all).
    // Also strips a stray ".jpg" suffix if the caller ever sends
    // avatar://{uid}.jpg instead of avatar://{uid} — getLocalAvatarPath()
    // already appends the real extension itself, so an extension in the
    // request would otherwise get treated as part of the uid and 404.
    const rawId = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''))
    const uid = rawId.replace(/\.jpe?g$|\.png$/i, '')
    const filePath = getLocalAvatarPath(uid)
    if (!existsSync(filePath)) {
      return new Response(null, { status: 404 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}
