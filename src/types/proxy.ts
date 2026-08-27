// ---------------------------------------------------------------------------
// Proxy domain types  — mirror the `proxies` table.
// ---------------------------------------------------------------------------

export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5' | string
export type ProxyStatus = 'Alive' | 'Dead' | 'Unknown' | string

export interface Proxy {
  id: number
  host: string
  port: number
  username: string | null
  password: string | null
  type: ProxyType
  status: ProxyStatus
  last_checked: string | null
}

export type NewProxy = Partial<Omit<Proxy, 'id'>> & {
  host: string
  port: number
}
