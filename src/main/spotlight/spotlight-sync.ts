import pLimit from 'p-limit'
import type { ApiTarget } from '@shared/lib/api-target'
import { POLL_HEADERS } from '../agent-status'
import type { SpotlightIndex } from './spotlight-bridge'
import {
  diffItems,
  fingerprint,
  itemsForTarget,
  workspaceItems,
  type SpotlightDomain,
  type SpotlightItem,
} from './spotlight-items'
import {
  parseEach,
  spotlightAgentSchema,
  spotlightSessionSchema,
  type SpotlightAgent,
  type SpotlightSession,
} from './spotlight-schema'

/** How often the index is reconciled with no reason to. Session events ask sooner. */
export const SYNC_INTERVAL_MS = 5 * 60_000

/** The first pass waits out the window's boot, which wants the API to itself. */
export const FIRST_PASS_DELAY_MS = 20_000

/** Session events come in bursts (a turn ends, its notification follows); one sync covers a burst. */
export const SYNC_DEBOUNCE_MS = 5_000

/**
 * An agent's sessions are re-listed when its activity changes, and at least
 * this often otherwise: a rename does not move the agent's activity.
 */
export const SESSIONS_MAX_AGE_MS = 60 * 60_000

/** The most recent sessions indexed per agent. */
export const SESSIONS_PER_AGENT = 50

const SESSION_FETCH_CONCURRENCY = 4
const REQUEST_TIMEOUT_MS = 15_000

export interface SpotlightSyncDeps {
  index: SpotlightIndex
  /**
   * Where each Superagent is reached right now, or null when there is none —
   * no cloud workspace, or no live token for one. Asked on every pass.
   */
  baseUrl(target: ApiTarget): string | null
  /** Which Superagent the app is driving. The cloud side is polled only while it is this one. */
  activeTarget(): ApiTarget
  fetch?: typeof fetch
  now?: () => number
}

/** A domain's next contents: these items, nothing (clear it), or unknown this pass (leave it). */
type Collected = SpotlightItem[] | 'absent' | 'keep'

interface CachedSessions {
  /** The agent's activity when these were listed. */
  signature: string
  fetchedAt: number
  sessions: SpotlightSession[]
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/**
 * Keeps the app's Spotlight entries in line with both Superagents: every
 * agent, dashboard and recent session on this computer and in the cloud
 * workspace, each labelled with where it lives, plus a switch-to result for
 * each side while there is a workspace.
 *
 * macOS never asks for any of it. The index persists across launches and only
 * changes when written, so this writes differences: the first pass in a process
 * replaces each domain whole (what the previous run left is unknown), later
 * passes send only what changed.
 *
 * A Superagent that cannot be reached keeps its entries; one that no longer
 * exists (the workspace was disconnected) or refuses us (the token was
 * rejected) loses them.
 *
 * The cloud side is polled only while the app is driving it. Otherwise it is
 * read once per launch and again on each switch: a desktop that is not using
 * the workspace should not be what keeps it awake.
 *
 * Never throws: Spotlight is a convenience, and every failure here is logged
 * and retried on the next pass.
 */
export class SpotlightSync {
  private readonly indexed: Record<SpotlightDomain, Map<string, string> | null> = {
    local: null,
    cloud: null,
    workspace: null,
  }
  private readonly sessionCache: Record<ApiTarget, Map<string, CachedSessions>> = {
    local: new Map(),
    cloud: new Map(),
  }
  /** The target the last pass saw, to notice a switch. */
  private lastTarget: ApiTarget | null = null
  /** Whether the cloud side has been read (answered or refused) since launch or the last switch. */
  private cloudRead = false
  private running: Promise<void> | null = null
  private again = false
  private stopped = false
  private firstPass: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: SpotlightSyncDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.firstPass || this.interval || this.stopped) return
    this.firstPass = setTimeout(() => {
      this.firstPass = null
      void this.sync()
      this.interval = setInterval(() => void this.sync(), SYNC_INTERVAL_MS)
    }, FIRST_PASS_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.firstPass) clearTimeout(this.firstPass)
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    this.firstPass = null
    this.interval = null
    this.debounce = null
  }

  /** Something probably changed: sync shortly, once per burst. A no-op before the first pass. */
  requestSync(): void {
    if (!this.interval) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.sync()
    }, SYNC_DEBOUNCE_MS)
  }

  /** One full pass. A call during a pass is folded into a single follow-up pass. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.syncOnce()
        } while (this.again && !this.stopped)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async syncOnce(): Promise<void> {
    const active = this.deps.activeTarget()
    if (active !== this.lastTarget) this.cloudRead = false
    this.lastTarget = active

    const localUrl = this.deps.baseUrl('local')
    const cloudUrl = this.deps.baseUrl('cloud')
    const readCloud = cloudUrl !== null && (active === 'cloud' || !this.cloudRead)
    const [local, cloud] = await Promise.all([
      localUrl ? this.collect('local', localUrl) : ('absent' as const),
      !cloudUrl ? ('absent' as const) : readCloud ? this.collect('cloud', cloudUrl) : ('keep' as const),
    ])
    if (readCloud && cloud !== 'keep') this.cloudRead = true
    if (this.stopped) return

    await this.reconcile('local', local)
    await this.reconcile('cloud', cloud)
    await this.reconcile('workspace', cloudUrl && cloud !== 'absent' ? workspaceItems() : 'absent')
  }

  private async collect(target: ApiTarget, baseUrl: string): Promise<Collected> {
    let agents: SpotlightAgent[]
    try {
      agents = parseEach(spotlightAgentSchema, await this.getJson(`${baseUrl}/api/agents`))
    } catch (error) {
      // Never the URL: the cloud one carries the per-boot proxy key.
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        console.warn(`[Spotlight] The ${target} agents were refused (${error.message}); removing its entries.`)
        return 'absent'
      }
      console.warn(`[Spotlight] Could not list the ${target} agents:`, describe(error))
      return 'keep'
    }

    const cache = this.sessionCache[target]
    const live = new Set(agents.map((agent) => agent.slug))
    for (const slug of cache.keys()) {
      if (!live.has(slug)) cache.delete(slug)
    }

    const limit = pLimit(SESSION_FETCH_CONCURRENCY)
    const lists = await Promise.all(agents.map((agent) => limit(() => this.sessionsFor(target, baseUrl, agent))))
    const sessionsByAgent = new Map(agents.map((agent, i) => [agent.slug, lists[i]]))
    return itemsForTarget(target, agents, sessionsByAgent)
  }

  private async sessionsFor(target: ApiTarget, baseUrl: string, agent: SpotlightAgent): Promise<SpotlightSession[]> {
    const signature = `${agent.lastActivityAt ?? ''}|${agent.sessionCount ?? ''}`
    const cache = this.sessionCache[target]
    const cached = cache.get(agent.slug)
    if (cached && cached.signature === signature && this.now() - cached.fetchedAt < SESSIONS_MAX_AGE_MS) {
      return cached.sessions
    }
    try {
      const url = `${baseUrl}/api/agents/${encodeURIComponent(agent.slug)}/sessions`
        + `?sort_by=last_activity_at&limit=${SESSIONS_PER_AGENT}`
      const sessions = parseEach(spotlightSessionSchema, await this.getJson(url))
      cache.set(agent.slug, { signature, fetchedAt: this.now(), sessions })
      return sessions
    } catch (error) {
      // One agent that will not list its sessions keeps the ones it had,
      // rather than having them deleted or holding up every other agent.
      console.warn(`[Spotlight] Could not list the sessions of a ${target} agent:`, describe(error))
      return cached?.sessions ?? []
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetch(url, { headers: POLL_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  }

  private async reconcile(domain: SpotlightDomain, next: Collected): Promise<void> {
    if (next === 'keep') return
    const indexed = this.indexed[domain]
    try {
      if (next === 'absent') {
        // Cleared once per process even with nothing known to be there: the
        // previous run may have left this domain's items behind.
        if (indexed?.size === 0) return
        await this.deps.index.apply({ deleteDomains: [domain] })
        if (domain !== 'workspace') this.sessionCache[domain].clear()
        console.log(`[Spotlight] ${domain}: cleared`)
      } else if (!indexed) {
        await this.deps.index.apply({ deleteDomains: [domain], index: next })
        console.log(`[Spotlight] ${domain}: indexed ${next.length}`)
      } else {
        const { upsert, remove } = diffItems(indexed, next)
        if (upsert.length === 0 && remove.length === 0) return
        await this.deps.index.apply({ deleteIds: remove, index: upsert })
        console.log(`[Spotlight] ${domain}: ${upsert.length} updated, ${remove.length} removed`)
      }
      this.indexed[domain] = new Map(next === 'absent' ? [] : next.map((item) => [item.id, fingerprint(item)]))
    } catch (error) {
      // What the index holds is unknown now: replace the domain whole next pass.
      this.indexed[domain] = null
      console.warn(`[Spotlight] Could not update the ${domain} entries:`, describe(error))
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
