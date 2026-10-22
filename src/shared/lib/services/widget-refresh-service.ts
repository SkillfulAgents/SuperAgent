import { agentRegistry } from '@shared/lib/agent-actor'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { background } from '@shared/lib/background'
import {
  containerWidgetRefreshResponseSchema,
  type ApiAgentWidget,
  type WidgetSnapshot,
} from '@shared/lib/widgets/widget-schema'
import { openWidgetRepairSession } from './widget-repair-service'
import { listWidgetsFromFilesystem } from './widget-service'

/**
 * Host-side orchestration of widget refreshes.
 *
 * A refresh always runs INSIDE the agent container (the script needs the
 * agent's tooling and credentials, and must not run on the host). This
 * service decides when to ask for one and keeps the renderer informed:
 *
 *   - on demand: Agent Home mounts → refreshStale(agent, { wake: true })
 *     (never on app launch — that would wake every container at once)
 *   - after a run: any session of the agent settles → every stale widget and
 *     every widget that opted in with refreshOnTurnEnd re-runs, debounced,
 *     only if the container is still up (it is — the turn just ended there)
 *   - explicit: the user taps refresh on a card
 *
 * There is no timer. A widget nobody looks at is never refreshed.
 *
 * When a refresh comes back with a script failure, `widget-repair-service`
 * opens an automated session asking the agent to fix its own script. Only a
 * script failure counts: a container that never answered is the platform's
 * problem, not the agent's.
 */

const CONTAINER_REFRESH_TIMEOUT_MS = 180_000
// Agent Home can mount many times a minute (tab switches, back/forward);
// a stale sweep that just ran is not repeated inside this window.
const STALE_SWEEP_THROTTLE_MS = 30_000
// Several sessions can settle within a moment of each other.
const POST_RUN_DEBOUNCE_MS = 3_000
// An opted-in (refreshOnTurnEnd) widget refreshed this recently is left alone
// by the post-run sweep — an automation firing every minute must not
// re-render it each time.
const POST_RUN_MIN_INTERVAL_MS = 60_000

export type RefreshReason = 'stale' | 'after-run' | 'manual'

export type RefreshOutcome =
  | { ok: true; snapshot: WidgetSnapshot }
  | { ok: false; error: string; skipped?: boolean }

const keyOf = (agentSlug: string, widgetSlug: string) => `${agentSlug}::${widgetSlug}`

class WidgetRefreshService {
  private inflight = new Map<string, Promise<RefreshOutcome>>()
  private lastCompletedAt = new Map<string, number>()
  private lastStaleSweepAt = new Map<string, number>()
  private postRunTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private unsubscribe: (() => void) | null = null

  /**
   * Arm the after-run trigger. Idempotent; called once at route registration.
   * Listens to the global feed for a session going idle, so nothing on the
   * session path has to know widgets exist.
   */
  start(): void {
    if (this.unsubscribe) return
    // Route modules arm this at import time; route tests replace the feed
    // with partial doubles that cannot be subscribed to, and must still load.
    if (typeof globalFeed.subscribe !== 'function') return
    this.unsubscribe = globalFeed.subscribe((event) => {
      if (event.type === 'session_idle' && typeof event.agentSlug === 'string') {
        this.schedulePostRun(event.agentSlug)
      }
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const timer of this.postRunTimers.values()) clearTimeout(timer)
    this.postRunTimers.clear()
  }

  isRefreshing(agentSlug: string, widgetSlug: string): boolean {
    return this.inflight.has(keyOf(agentSlug, widgetSlug))
  }

  refreshingSlugs(agentSlug: string): string[] {
    const prefix = `${agentSlug}::`
    return [...this.inflight.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
  }

  /** Attach live `refreshing` flags to a filesystem listing. */
  decorate(agentSlug: string, widgets: ApiAgentWidget[]): ApiAgentWidget[] {
    return widgets.map((w) => ({ ...w, refreshing: this.isRefreshing(agentSlug, w.slug) }))
  }

  /**
   * Refresh one widget. Single-flight per widget. With `wake: false` a
   * sleeping container is left asleep and the call reports `skipped`.
   */
  refreshWidget(
    agentSlug: string,
    widgetSlug: string,
    opts: { wake: boolean; reason: RefreshReason },
  ): Promise<RefreshOutcome> {
    const key = keyOf(agentSlug, widgetSlug)
    const existing = this.inflight.get(key)
    if (existing) return existing

    const run = this.doRefresh(agentSlug, widgetSlug, opts).finally(() => {
      if (this.inflight.get(key) === run) this.inflight.delete(key)
      this.lastCompletedAt.set(key, Date.now())
    })
    this.inflight.set(key, run)
    return run
  }

  private async doRefresh(
    agentSlug: string,
    widgetSlug: string,
    opts: { wake: boolean; reason: RefreshReason },
  ): Promise<RefreshOutcome> {
    if (!opts.wake && (await agentRegistry.get(agentSlug).container.status()).status !== 'running') {
      return { ok: false, error: 'Agent is not running', skipped: true }
    }
    globalFeed.publish({
      type: 'widget_refresh_started',
      agentSlug,
      widgetSlug,
      reason: opts.reason,
    })
    try {
      const actor = agentRegistry.get(agentSlug)
      if (opts.wake) await actor.container.start()
      const response = await actor.container.fetch(`/artifacts/${encodeURIComponent(widgetSlug)}/widget/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: opts.reason }),
        signal: AbortSignal.timeout(CONTAINER_REFRESH_TIMEOUT_MS),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `Container refused widget refresh (HTTP ${response.status})`)
      }
      const snapshot = containerWidgetRefreshResponseSchema.parse(await response.json())
      // The container also posts widget-snapshot-ready; this covers the mock
      // runtime and any container old enough not to. The handler is idempotent.
      globalFeed.publish({
        type: 'widget_snapshot_ready',
        agentSlug,
        widgetSlug,
        generatedAt: snapshot.generatedAt,
        validUntil: snapshot.validUntil,
        htmlHash: snapshot.htmlHash,
        error: snapshot.lastError,
      })
      // The container ran and the SCRIPT failed — that is the agent's code,
      // and no turn is going to notice on its own. Ask the agent to fix it.
      if (snapshot.lastError) {
        background(openWidgetRepairSession(agentSlug, widgetSlug, snapshot.lastError).catch((err) => {
          console.warn(`[WidgetRefresh] repair session for ${agentSlug}/${widgetSlug} failed:`, err)
        }), { name: 'widget-refresh.open-repair-session' })
      }
      return { ok: true, snapshot }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[WidgetRefresh] ${agentSlug}/${widgetSlug} (${opts.reason}) failed: ${message}`)
      globalFeed.publish({
        type: 'widget_refresh_failed',
        agentSlug,
        widgetSlug,
        error: message,
      })
      return { ok: false, error: message }
    }
  }

  /**
   * Kick off refreshes for every stale widget of an agent and return the
   * slugs now in flight (including ones already running). Fire-and-forget:
   * completion arrives as widget_snapshot_ready / widget_refresh_failed.
   */
  async refreshStale(
    agentSlug: string,
    opts: { wake: boolean; force?: boolean },
  ): Promise<{ refreshing: string[] }> {
    const now = Date.now()
    const last = this.lastStaleSweepAt.get(agentSlug) ?? 0
    if (!opts.force && now - last < STALE_SWEEP_THROTTLE_MS) {
      return { refreshing: this.refreshingSlugs(agentSlug) }
    }
    this.lastStaleSweepAt.set(agentSlug, now)

    const widgets = await listWidgetsFromFilesystem(agentSlug)
    const stale = widgets.filter((w) => w.isStale)
    for (const widget of stale) {
      background(this.refreshWidget(agentSlug, widget.slug, { wake: opts.wake, reason: 'stale' }), { name: 'widget-refresh.refresh-widget' })
    }
    return { refreshing: this.refreshingSlugs(agentSlug) }
  }

  /**
   * After a run: every widget that is stale (the run rewrote its widget.html,
   * or validUntil has passed) is refreshed, and every widget that opted in
   * with `refreshOnTurnEnd` is refreshed whether stale or not — its data is
   * the kind the agent changes in conversation. Never wakes a container.
   */
  schedulePostRun(agentSlug: string): void {
    const existing = this.postRunTimers.get(agentSlug)
    if (existing) clearTimeout(existing)
    this.postRunTimers.set(
      agentSlug,
      setTimeout(() => {
        this.postRunTimers.delete(agentSlug)
        background(this.runPostRun(agentSlug).catch((error) => {
          console.warn(`[WidgetRefresh] post-run sweep for ${agentSlug} failed:`, error)
        }), { name: 'widget-refresh.post-run-sweep' })
      }, POST_RUN_DEBOUNCE_MS),
    )
  }

  async runPostRun(agentSlug: string): Promise<string[]> {
    if ((await agentRegistry.get(agentSlug).container.status()).status !== 'running') return []
    const widgets = await listWidgetsFromFilesystem(agentSlug)
    const now = Date.now()
    const picked = widgets.filter((w) => {
      if (w.isStale) return true
      if (!w.refreshOnTurnEnd || !(w.hasScript || w.hasHtml)) return false
      // An automation firing every minute must not re-render an opted-in
      // widget each time; a fresh one is left alone inside this window.
      const completed = this.lastCompletedAt.get(keyOf(agentSlug, w.slug)) ?? 0
      return now - completed >= POST_RUN_MIN_INTERVAL_MS
    })
    for (const widget of picked) {
      background(this.refreshWidget(agentSlug, widget.slug, { wake: false, reason: 'after-run' }), { name: 'widget-refresh.refresh-widget' })
    }
    return picked.map((w) => w.slug)
  }

  /** Test seam. */
  resetForTests(): void {
    this.stop()
    this.inflight.clear()
    this.lastCompletedAt.clear()
    this.lastStaleSweepAt.clear()
  }
}

export const widgetRefreshService = new WidgetRefreshService()
