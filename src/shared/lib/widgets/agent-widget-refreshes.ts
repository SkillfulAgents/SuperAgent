/**
 * One agent's widget refreshes, as the host's refresh service tracks them:
 * which widgets are refreshing now and how each refresh in flight ends for
 * whoever joined it, when each widget last finished refreshing, when the last
 * stale sweep ran, and how many of the agent's runs have ended (the post-run
 * sweep's debounce). The service decides when to refresh; this only
 * remembers, so the memory lives with the agent.
 */
import { randomUUID } from 'crypto'
import type { WidgetSnapshot } from './widget-schema'

/** How a refresh ended: the container's snapshot, or why there is none. */
export type WidgetRefreshOutcome =
  | { ok: true; snapshot: WidgetSnapshot }
  | { ok: false; error: string; skipped?: boolean }

interface RefreshInFlight {
  token: string
  joiners: Array<(outcome: WidgetRefreshOutcome) => void>
}

export class AgentWidgetRefreshes {
  private inFlight = new Map<string, RefreshInFlight>()
  private finishedAt = new Map<string, number>()
  private staleSweepAt = 0
  private runsEnded = 0

  /** Start refreshing a widget unless a refresh of it is in flight: the token that finishes it, or null. */
  begin(widgetSlug: string): string | null {
    if (this.inFlight.has(widgetSlug)) return null
    const token = randomUUID()
    this.inFlight.set(widgetSlug, { token, joiners: [] })
    return token
  }

  /** The refresh `token` began is over: hand its outcome to whoever joined it, and note when it ended. */
  finish(widgetSlug: string, token: string, outcome: WidgetRefreshOutcome, at = Date.now()): void {
    const refresh = this.inFlight.get(widgetSlug)
    if (refresh?.token !== token) return
    this.inFlight.delete(widgetSlug)
    this.finishedAt.set(widgetSlug, at)
    for (const join of refresh.joiners) join(outcome)
  }

  /** How the refresh in flight ends; null when none is in flight. */
  join(widgetSlug: string): Promise<WidgetRefreshOutcome | null> {
    const refresh = this.inFlight.get(widgetSlug)
    if (!refresh) return Promise.resolve(null)
    return new Promise((resolve) => refresh.joiners.push(resolve))
  }

  /** The widgets with a refresh in flight. */
  refreshing(): string[] {
    return [...this.inFlight.keys()]
  }

  /** When each widget's last refresh ended, epoch ms by widget slug. */
  refreshedAt(): Record<string, number> {
    return Object.fromEntries(this.finishedAt)
  }

  /** True, and noted, unless a stale sweep ran within `throttleMs`. */
  claimStaleSweep(throttleMs: number, now = Date.now()): boolean {
    if (now - this.staleSweepAt < throttleMs) return false
    this.staleSweepAt = now
    return true
  }

  /** One of the agent's runs ended: the stamp a post-run sweep is due for. */
  notePostRun(): number {
    return ++this.runsEnded
  }

  /** Whether no run has ended since the one `stamp` noted. */
  isLatestPostRun(stamp: number): boolean {
    return stamp === this.runsEnded
  }

  /** The agent is gone: whoever joined a refresh hears it will not end here. */
  dispose(): void {
    const gone: WidgetRefreshOutcome = { ok: false, error: 'The agent is no longer held by this process' }
    for (const refresh of this.inFlight.values()) {
      for (const join of refresh.joiners) join(gone)
    }
    this.inFlight.clear()
    this.finishedAt.clear()
  }
}
