// ---------------------------------------------------------------------------
// networkWatchdog.ts  — internet connectivity heartbeat + automation failsafe.
//
// Polls connectivity every 3s via a raw TCP connect to 1.1.1.1:53 (Cloudflare's
// DNS resolver) with a DNS lookup of a well-known hostname as a fallback —
// no HTTP request, no extra dependency, and both checks fail fast (short
// timeout) rather than hanging if the network is actually down.
//
// On a transition from "online" to "offline" while an automation run is
// active: halts the queue (stopActiveRun — the same path a manual Stop
// click uses), closes every tracked Chrome browser instance, and lets the
// existing runAutoLogin/queueRunner flow persist each in-flight account's
// last known state/cookie/token to SQLite exactly as it already does for a
// manual Stop (see queueRunner.ts — a Stop mid-run still saves whatever
// each worker had already extracted before the abort).
//
// Deliberately does NOT close/quit the app itself: killing the whole
// application the instant a network blip is detected would be far more
// disruptive than protective, and the accounts' state is already safe once
// the browsers are closed — the user should decide whether to quit, wait
// for the network to return, or investigate.
// ---------------------------------------------------------------------------
import { createConnection } from 'net'
import { lookup } from 'dns/promises'
import { BrowserWindow } from 'electron'
import { isAnyBatchRunning, stopActiveRun } from '../automation/activeRun'
import { closeAllTrackedContexts } from '../automation/browserContext'
import { IPC } from '../ipc/channels'

const CHECK_INTERVAL_MS = 3000
const CHECK_TIMEOUT_MS = 2500
const PROBE_HOST = '1.1.1.1'
const PROBE_PORT = 53
const FALLBACK_HOSTNAME = 'google.com'

let timer: ReturnType<typeof setInterval> | null = null
let isOnline = true

function tcpProbe(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: PROBE_HOST, port: PROBE_PORT, timeout: CHECK_TIMEOUT_MS })
    const finish = (result: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function dnsProbe(): Promise<boolean> {
  try {
    await lookup(FALLBACK_HOSTNAME)
    return true
  } catch {
    return false
  }
}

async function checkOnline(): Promise<boolean> {
  // Either succeeding is enough — the TCP probe is the primary check (fast,
  // doesn't depend on DNS working), the DNS lookup is the fallback for a
  // network that blocks raw port 53 but still resolves hostnames fine.
  if (await tcpProbe()) return true
  return dnsProbe()
}

function broadcastStatus(online: boolean): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.system.onNetworkStatus, { online })
  }
}

async function tick(): Promise<void> {
  const online = await checkOnline()
  if (online === isOnline) return

  isOnline = online
  broadcastStatus(online)

  if (!online && isAnyBatchRunning()) {
    // Failsafe: the network just dropped mid-run. Stop first (aborts every
    // in-flight worker's signal, which is what actually triggers each
    // runAutoLogin call's own try/finally to persist state and close its
    // browser — see autoLogin.ts), then sweep any browser windows that
    // weren't mid-login (e.g. an Open Profile window with nothing running
    // against it) so nothing is left dangling either way.
    stopActiveRun()
    await closeAllTrackedContexts().catch(() => void 0)
  }
}

/** Starts the connectivity heartbeat. Safe to call once at app startup; idempotent if called again. */
export function startNetworkWatchdog(): void {
  if (timer) return
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS)
}

export function stopNetworkWatchdog(): void {
  if (timer) clearInterval(timer)
  timer = null
}
