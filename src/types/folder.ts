// ---------------------------------------------------------------------------
// Folder domain types  — mirror the `folders` table.
// ---------------------------------------------------------------------------

export interface Folder {
  id: number
  name: string
  created_at: string
  /** Live count of accounts assigned to this folder. */
  account_count: number
}

/** Sentinel used in the UI folder selector to mean "no folder filter". */
export const ALL_FOLDERS = -1
