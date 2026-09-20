// ---------------------------------------------------------------------------
// Scenario domain types — the account "warm-up" action pipeline.
// Mirrors the `scenarios` table (steps stored as JSON) 1:1.
// ---------------------------------------------------------------------------

export type ScenarioStepType =
  | 'scroll_newsfeed'
  | 'like_random_posts'
  | 'watch_reels'
  | 'view_stories'
  | 'view_photo_post'
  | 'visit_profile'
  | 'random_delay'

export type ScrollDirectionMode = 'mostly_down' | 'down_and_up'

export interface ScenarioStepBase {
  id: string // client-generated uuid-ish key, stable for React keys / reordering
  type: ScenarioStepType
  enabled: boolean
}

export interface ScrollNewsfeedStep extends ScenarioStepBase {
  type: 'scroll_newsfeed'
  minSeconds: number
  maxSeconds: number
  /** Default: down_and_up. Older saved scenarios omit this field. */
  scrollMode?: ScrollDirectionMode
}

export interface LikeRandomPostsStep extends ScenarioStepBase {
  type: 'like_random_posts'
  minCount: number
  maxCount: number
}

export interface WatchReelsStep extends ScenarioStepBase {
  type: 'watch_reels'
  minCount: number
  maxCount: number
  minDurationSeconds: number
  maxDurationSeconds: number
}

export interface ViewStoriesStep extends ScenarioStepBase {
  type: 'view_stories'
  minCount: number
  maxCount: number
}

export interface RandomDelayStep extends ScenarioStepBase {
  type: 'random_delay'
  minSeconds: number
  maxSeconds: number
}

export interface ViewPhotoPostStep extends ScenarioStepBase {
  type: 'view_photo_post'
  minCount: number
  maxCount: number
  minDurationSeconds: number
  maxDurationSeconds: number
}

export interface VisitProfileStep extends ScenarioStepBase {
  type: 'visit_profile'
  minSeconds: number
  maxSeconds: number
}

export type ScenarioStep =
  | ScrollNewsfeedStep
  | LikeRandomPostsStep
  | WatchReelsStep
  | ViewStoriesStep
  | ViewPhotoPostStep
  | VisitProfileStep
  | RandomDelayStep

export interface Scenario {
  id: number
  name: string
  steps: ScenarioStep[]
  randomize_order?: boolean
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface NewScenario {
  name: string
  steps: ScenarioStep[]
  randomize_order?: boolean
}

export const STEP_LABELS: Record<ScenarioStepType, string> = {
  scroll_newsfeed: 'Scroll Newsfeed',
  like_random_posts: 'Auto Like Random Posts',
  watch_reels: 'Watch Facebook Watch / Reels',
  view_stories: 'View Stories',
  view_photo_post: 'View Photo / Post',
  visit_profile: 'Visit Profile',
  random_delay: 'Random Delay'
}

let stepIdCounter = 0
export function newStepId(): string {
  stepIdCounter += 1
  return `step_${Date.now()}_${stepIdCounter}`
}

export function defaultStep(type: ScenarioStepType): ScenarioStep {
  const id = newStepId()
  switch (type) {
    case 'scroll_newsfeed':
      return {
        id,
        type,
        enabled: true,
        minSeconds: 30,
        maxSeconds: 60,
        scrollMode: 'down_and_up'
      }
    case 'like_random_posts':
      return { id, type, enabled: true, minCount: 1, maxCount: 3 }
    case 'watch_reels':
      return {
        id,
        type,
        enabled: true,
        minCount: 1,
        maxCount: 2,
        minDurationSeconds: 60,
        maxDurationSeconds: 120
      }
    case 'view_stories':
      return { id, type, enabled: true, minCount: 2, maxCount: 4 }
    case 'view_photo_post':
      return {
        id,
        type,
        enabled: true,
        minCount: 1,
        maxCount: 2,
        minDurationSeconds: 4,
        maxDurationSeconds: 10
      }
    case 'visit_profile':
      return { id, type, enabled: true, minSeconds: 8, maxSeconds: 20 }
    case 'random_delay':
      return { id, type, enabled: true, minSeconds: 10, maxSeconds: 30 }
  }
}

/** The scenario every fresh database is seeded with. */
export const DEFAULT_WARMUP_STEPS: ScenarioStep[] = [
  { id: 'seed_1', type: 'scroll_newsfeed', enabled: true, minSeconds: 30, maxSeconds: 60 },
  {
    id: 'seed_2',
    type: 'random_delay',
    enabled: true,
    minSeconds: 10,
    maxSeconds: 30
  },
  { id: 'seed_3', type: 'like_random_posts', enabled: true, minCount: 1, maxCount: 3 },
  {
    id: 'seed_4',
    type: 'watch_reels',
    enabled: true,
    minCount: 1,
    maxCount: 2,
    minDurationSeconds: 60,
    maxDurationSeconds: 120
  },
  { id: 'seed_5', type: 'view_stories', enabled: true, minCount: 2, maxCount: 4 }
]

export const DEFAULT_SCENARIO_NAME = 'Default Warm-up'
