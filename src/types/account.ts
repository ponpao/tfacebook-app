// ---------------------------------------------------------------------------
// Account domain types  — shared between main, preload and renderer processes.
// Field names mirror the `accounts` table columns 1:1 (snake_case) so we can
// pass rows straight through IPC without a mapping layer.
// ---------------------------------------------------------------------------

export type AccountStatus =
  | 'Live'
  | 'Checkpoint'
  | 'Die'
  | 'Changed Pass'
  | 'Unknown'
  | string // allow custom user-defined statuses

export interface Account {
  id: number
  uid: string | null
  password: string | null
  two_fa: string | null
  email: string | null
  email_pass: string | null
  mail_server: string | null
  name: string | null
  dob: string | null
  created_date: string | null
  location: string | null
  gender: string | null
  friends_count: number
  groups_count: number
  pages_count: number
  /** JSON array of managed pages: [{ pageId, name, assetId, url }] */
  pages_data?: string | null
  /** JSON array of friend display names, stringified. */
  friends_list: string | null
  followers: string | null
  following: string | null
  current_location: string | null
  dtsg_token: string | null
  cookie: string | null
  token: string | null
  proxy: string | null
  avatar: string | null
  user_agent: string | null
  last_active: string | null
  status: AccountStatus
  status_detail: string | null
  live_status: string | null // live process status (Trạng Thái)
  profile_dir: string | null
  backup_data: string | null // JSON string (friends list / recovery info)
  notes: string | null
  folder_id: number | null
  /** Joined from the folders table — present on list queries. */
  folder_name?: string | null
  is_deleted: boolean
  deleted_at: string | null
  created_at: string
  updated_at: string
}

/** Payload accepted when creating/importing an account. All fields optional
 *  except the ones the parser is able to fill in. */
export type NewAccount = Partial<Omit<Account, 'id' | 'created_at' | 'updated_at'>>

/** Partial patch for updating a single account. */
export type AccountUpdate = Partial<Omit<Account, 'id' | 'created_at' | 'updated_at'>>

/** Query parameters for the paginated / filtered account list. */
export interface AccountQuery {
  search?: string
  /** Which column the free-text search targets. */
  searchField?: 'uid' | 'email' | 'name' | 'proxy'
  status?: AccountStatus | 'All'
  /** Folder filter. Omit or ALL_FOLDERS (-1) for all folders. */
  folderId?: number
  limit?: number
  offset?: number
  sortBy?: keyof Account
  sortDir?: 'asc' | 'desc'
}

export interface AccountListResult {
  rows: Account[]
  total: number
}

/** Aggregate counts shown in the dashboard header. */
export interface AccountStats {
  total: number
  live: number
  checkpoint: number
  die: number
  changed: number
  unknown: number
  error: number
  proxies: number
}

export interface ManagedPage {
  pageId: string
  name: string
  assetId?: string
  url?: string
}

export type PagePostType = 'ALL' | 'REEL' | 'PHOTO' | 'STATUS'

export interface PagePost {
  id: string
  type: 'Reel' | 'Photo' | 'Status'
  date: string
  title: string
  views: number
  likes: number
  reach: number
  status?: 'Published' | 'Deleting' | 'Deleting...' | 'Processing...' | '✓ Completed' | '✗ Failed' | 'In Trash' | 'Failed' | string
}

export interface PagePostFilter {
  fromDate?: string
  toDate?: string
  targetType?: PagePostType
}
