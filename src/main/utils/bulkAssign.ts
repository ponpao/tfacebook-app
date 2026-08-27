// ---------------------------------------------------------------------------
// bulkAssign.ts  — pure distribution logic for bulk Proxy / Useragent import.
//   sequential : 1:1 in order, cycling the value list if shorter than accounts
//   random     : each account gets a random value from the list
//   shared     : every N accounts share the same value, cycling through the list
// ---------------------------------------------------------------------------
import type { ProxyAssignMode } from '../../types/marketing'

export function distributeValues(
  accountIds: number[],
  values: string[],
  mode: ProxyAssignMode,
  sharePerN = 1
): { id: number; value: string }[] {
  const cleanValues = values.map((v) => v.trim()).filter(Boolean)
  if (accountIds.length === 0 || cleanValues.length === 0) return []

  switch (mode) {
    case 'sequential':
      return accountIds.map((id, i) => ({ id, value: cleanValues[i % cleanValues.length] }))

    case 'random':
      return accountIds.map((id) => ({
        id,
        value: cleanValues[Math.floor(Math.random() * cleanValues.length)]
      }))

    case 'shared': {
      const n = Math.max(1, Math.floor(sharePerN) || 1)
      return accountIds.map((id, i) => {
        const groupIndex = Math.floor(i / n)
        return { id, value: cleanValues[groupIndex % cleanValues.length] }
      })
    }
  }
}
