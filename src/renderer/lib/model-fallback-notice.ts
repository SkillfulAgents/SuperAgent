import { toast } from 'sonner'

import type { ModelDefinition } from '@shared/lib/llm-provider'

const STORAGE_PREFIX = 'superagent:model-fallback-notice:'
// Composers mount several at once (agent home, quick dispatch); one notice per page load.
const shownThisSession = new Set<string>()

function alreadyShown(key: string): boolean {
  if (shownThisSession.has(key)) return true
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key) !== null
  } catch {
    return false
  }
}

function markShown(key: string): void {
  shownThisSession.add(key)
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, new Date().toISOString())
  } catch {
    // Storage is a convenience: without it the notice can show again next launch.
  }
}

/**
 * Tell the user, once per reason, that a saved model the connection cannot
 * run (a default, or a chat's own) was passed over for the next one that can.
 * Saved defaults are kept, so they come back without another notice once they
 * can run again. `reason` is the provider's sentence; a new reason (another
 * plan) notifies again.
 */
export function announceModelFallback(input: {
  locked: ModelDefinition
  fallback: ModelDefinition
  reason: string
  action?: { label: string; run: () => void }
}): void {
  const key = `${input.locked.id}:${input.reason}`
  if (alreadyShown(key)) return
  markShown(key)
  toast(input.reason, {
    description: `Using ${input.fallback.label} instead.`,
    ...(input.action && { action: { label: input.action.label, onClick: input.action.run } }),
    duration: 10_000,
  })
}
