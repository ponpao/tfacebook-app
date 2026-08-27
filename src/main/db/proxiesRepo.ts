// ---------------------------------------------------------------------------
// proxiesRepo.ts  — SQL for the `proxies` table.
// ---------------------------------------------------------------------------
import { getDb } from './database'
import type { NewProxy, Proxy } from '../../types/proxy'

export function listProxies(): Proxy[] {
  return getDb().prepare(`SELECT * FROM proxies ORDER BY id DESC`).all() as Proxy[]
}

export function addProxies(proxies: NewProxy[]): number {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO proxies (host, port, username, password, type, status)
     VALUES (@host, @port, @username, @password, @type, @status)`
  )
  const tx = db.transaction((list: NewProxy[]) => {
    let n = 0
    for (const p of list) {
      n += stmt.run({
        host: p.host,
        port: p.port,
        username: p.username ?? null,
        password: p.password ?? null,
        type: p.type ?? 'http',
        status: p.status ?? 'Unknown'
      }).changes
    }
    return n
  })
  return tx(proxies)
}

export function deleteProxies(ids: number[]): number {
  if (ids.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(`DELETE FROM proxies WHERE id = ?`)
  const tx = db.transaction((list: number[]) => {
    let n = 0
    for (const id of list) n += stmt.run(id).changes
    return n
  })
  return tx(ids)
}

export function countProxies(): number {
  return (getDb().prepare(`SELECT COUNT(*) as c FROM proxies`).get() as { c: number }).c
}
