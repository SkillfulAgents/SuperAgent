import { toast } from 'sonner'

import type { ModelDefinition } from '@shared/lib/llm-provider'

const STORAGE_PREFIX = 'superagent:plan-fallback-notice:'
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
 * Tell the user, once per plan and model, that a saved default the plan
 * excludes was swapped for an allowed model in new chats. The saved default is
 * kept, so upgrading brings it back without another notice.
 */
export function announcePlanFallback(input: {
  locked: ModelDefinition
  fallback: ModelDefinition
  planName: string | undefined
  onUpgrade: () => void
}): void {
  const key = `${input.planName ?? 'plan'}:${input.locked.id}`
  if (alreadyShown(key)) return
  markShown(key)
  toast(`${input.locked.label} isn't included in ${input.planName ? `your ${input.planName} plan` : "your workspace's plan"}`, {
    description: `New chats use ${input.fallback.label} until you upgrade. Your default isn't changed.`,
    action: { label: 'Upgrade', onClick: input.onUpgrade },
    duration: 10_000,
  })
}
