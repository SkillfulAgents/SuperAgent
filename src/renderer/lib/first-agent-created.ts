import { captureRendererException } from '@renderer/lib/error-reporting'

const STORAGE_KEY_PREFIX = 'analytics.firstAgentCreated:'
// Fallback when localStorage is unavailable — dedupes within the app session.
const claimedInMemory = new Set<string>()

/**
 * Claims the once-per-user first_agent_created slot. Returns true exactly once
 * per userId (best-effort: persisted in localStorage, in-memory fallback).
 */
export function claimFirstAgentCreated(userId: string): boolean {
  if (claimedInMemory.has(userId)) return false
  claimedInMemory.add(userId)
  try {
    if (localStorage.getItem(STORAGE_KEY_PREFIX + userId) !== null) return false
    localStorage.setItem(STORAGE_KEY_PREFIX + userId, new Date().toISOString())
  } catch (err) {
    captureRendererException(err, { tags: { area: 'analytics', op: 'first-agent-created-claim' } })
  }
  return true
}

/** Test-only: clears the in-memory claim cache. */
export function resetFirstAgentCreatedMemoryForTest(): void {
  claimedInMemory.clear()
}
