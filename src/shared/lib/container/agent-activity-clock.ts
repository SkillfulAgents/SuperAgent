// Host-wide in-memory last-activity timestamps for AutoSleepMonitor.
// Separate module to avoid import cycles with message-persister / container-manager.

const lastActivityAt = new Map<string, number>()

export function touchAgentActivity(agentId: string, atMs: number = Date.now()): void {
  const prev = lastActivityAt.get(agentId)
  if (prev === undefined || atMs > prev) {
    lastActivityAt.set(agentId, atMs)
  }
}

export function getAgentLastActivity(agentId: string): number | undefined {
  return lastActivityAt.get(agentId)
}

export function clearAgentActivity(agentId: string): void {
  lastActivityAt.delete(agentId)
}

export function clearAllAgentActivity(): void {
  lastActivityAt.clear()
}
