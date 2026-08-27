// ---------------------------------------------------------------------------
// marketing.ts  — shared types for Row 2 marketing automation (Auto Post,
// Auto Share, Change Info) and bulk proxy/useragent assignment.
// ---------------------------------------------------------------------------

export type PostDestination = 'feed' | 'groups'

export interface AutoPostRequest {
  accountIds: number[]
  concurrency: number
  destination: PostDestination
  contentTemplate: string
  imagePaths?: string[]
  groupCount?: number
  delayMinSeconds?: number
  delayMaxSeconds?: number
}

export type ShareDestination = 'wall' | 'groups'

export interface AutoShareRequest {
  accountIds: number[]
  concurrency: number
  targetUrl: string
  destination: ShareDestination
  captionTemplate?: string
  groupCount?: number
  delayMinSeconds?: number
  delayMaxSeconds?: number
}

export interface WatchLiveRequest {
  accountIds: number[]
  concurrency: number
  liveUrl: string
  watchSeconds: number
  comments?: string[]
}

export interface AboutFieldRequest {
  template: string
}

export interface UpdateAboutRequest {
  bio?: AboutFieldRequest
  work?: AboutFieldRequest
  currentCity?: AboutFieldRequest
  hometown?: AboutFieldRequest
  highSchool?: AboutFieldRequest
  skipIfAlreadySet?: boolean
}

export interface ImagePickRequest {
  folderPath: string
  skipIfExists?: boolean
  deleteUsedImage?: boolean
}

export interface ChangeInfoRequest {
  accountIds: number[]
  concurrency: number
  changePassword?: { pattern?: string }
  updateAbout?: UpdateAboutRequest
  changeAvatar?: ImagePickRequest
  changeCover?: ImagePickRequest
  enable2FA?: boolean
}

export interface BatchSummary {
  total: number
  succeeded: number
  failed: number
  cancelled: boolean
}

export type ProxyAssignMode = 'sequential' | 'random' | 'shared'

export interface AssignProxyRequest {
  accountIds: number[]
  proxies: string[] // raw lines, one proxy per line
  mode: ProxyAssignMode
  /** Only used when mode = 'shared': how many accounts share each proxy. */
  sharePerN?: number
}

export interface AssignUseragentRequest {
  accountIds: number[]
  userAgents: string[]
  mode: ProxyAssignMode
  sharePerN?: number
}

export interface AssignResult {
  assigned: number
}
