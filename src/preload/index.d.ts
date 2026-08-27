import type { AppApi } from '../types/ipc'

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
