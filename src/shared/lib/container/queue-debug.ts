import { getSettings } from '@shared/lib/config/settings'

export function queueDebug(message: string, extra?: Record<string, unknown>): void {
  if (process.env.SUPERAGENT_DEBUG_QUEUE !== '1') {
    try {
      if (getSettings().customEnvVars?.SUPERAGENT_DEBUG_QUEUE !== '1') return
    } catch (err) {
      console.warn('[queue-debug] failed to read settings', err)
      return
    }
  }
  if (extra) console.log(`[queue-debug] ${message}`, extra)
  else console.log(`[queue-debug] ${message}`)
}
