import type { ApiTarget } from '@shared/lib/api-target'
import { PassTask, serviceHost, taskManager, type Service } from '@shared/lib/background-work'
import { agentStatusPushSchema } from '@shared/lib/types/agent-status-push'
import { fetchAgentsWithStatus, type AgentInfo } from './agent-status'

/**
 * The one list of agents and their activity that the tray and the Agents menu
 * are both drawn from. Consumers are told only when the ordered
 * `{slug, name, activityStatus}` list changes, so an unchanged list rebuilds
 * no native menu.
 *
 * Where the list comes from:
 *
 * - **A main window is alive:** its renderer pushes the list (`acceptPush`).
 *   Its agents query is kept current by the notification stream of whichever
 *   Superagent the window drives, local or cloud, so main asks the API nothing.
 * - **No window** (closed, crashed, reloading, signed out, or not yet pushed):
 *   main asks the API itself, every `AGENT_STATUS_POLL_INTERVAL_MS`. For this
 *   computer's Superagent it also asks shortly after its notification stream
 *   says something moved (`requestRefresh`). That stream is this computer's
 *   only, so the cloud workspace with no window has the interval alone.
 *
 * The stream does not announce everything. Nothing says the saved agent order
 * changed, and a delete, a rename or a create through the plain agent routes
 * publishes no event of its own. A window's own queries cover those; without
 * one the interval does.
 */

/** How often main asks the API when no window is pushing. */
export const AGENT_STATUS_POLL_INTERVAL_MS = 120_000

/** Stream events come in bursts (a session goes active, its agent's status follows); one fetch covers a burst. */
export const AGENT_STATUS_DEBOUNCE_MS = 1_000

const RECURRING_POLL_JOB = 'agent-status.recurring-poll'
const DEBOUNCED_POLL_JOB = 'agent-status.debounced-poll'

/**
 * The events on `/api/notifications/stream` after which an agent's row in the
 * list can read differently: a session started or stopped working or waiting,
 * a review opened or settled (it raises "needs input" with no session), a
 * container changed state, an agent was created by another agent or had its
 * name or avatar set for it. `connected` is the stream (re)attaching, after
 * which anything may have been missed.
 */
const AGENT_STATUS_EVENTS: ReadonlySet<string> = new Set([
  'connected',
  'session_active',
  'session_idle',
  'session_error',
  'session_awaiting_input',
  'session_input_provided',
  'user_request_created',
  'user_request_resolved',
  'agent_status_changed',
  'agent_created',
  'agent_updated',
])

export function isAgentStatusEvent(type: unknown): boolean {
  return typeof type === 'string' && AGENT_STATUS_EVENTS.has(type)
}

export interface AgentStatusDeps {
  /**
   * Which Superagent the app is driving and the base URL that reaches it (in
   * cloud mode the keyed proxy prefix). Asked on every fetch and every push,
   * since a target switch changes the answer.
   */
  activeTarget(): Promise<{ target: ApiTarget; baseUrl: string }>
  fetch?: typeof fetch
}

/** The slice of a window's `WebContents` the source needs, to know when its list stops being kept current. */
export interface AgentStatusPusher {
  isDestroyed(): boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

type Listener = (agents: AgentInfo[]) => void

function listKey(agents: AgentInfo[]): string {
  return JSON.stringify(agents.map((agent) => [agent.slug, agent.name, agent.activityStatus]))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AgentStatusSource implements Service {
  readonly id = 'agent-status'
  private deps: AgentStatusDeps | null = null
  private readonly listeners = new Set<Listener>()
  /** The list last handed to the consumers. Null until there has been one. */
  private agents: AgentInfo[] | null = null
  private key: string | null = null
  /**
   * Fetches overlap (the interval, a stream refresh, a target switch), and the
   * base URL is sampled before the await: a slow answer from the previous
   * target must not land over a newer one. Last started wins, and a push,
   * which is newer than any fetch in flight, starts a generation of its own.
   */
  private generation = 0
  /** The window whose pushed list is in force. Main does not poll while there is one. */
  private pusher: AgentStatusPusher | null = null
  /** Pushes resolve the active target before they apply; a later push or a release overtakes an earlier one. */
  private pushSequence = 0
  private readonly watched = new WeakSet<AgentStatusPusher>()
  /** The target the last fetch or push was for: stream refreshes are for the local one only. */
  private lastTarget: ApiTarget | null = null
  private scheduled = false
  private stopped = false
  private readonly pollTask = new PassTask('agent-status.poll', () => this.poll())
  readonly tasks = [this.pollTask]

  configure(deps: AgentStatusDeps): void {
    this.deps = deps
  }

  /** The first fetch now, then the interval. */
  start(): void {
    if (this.scheduled || this.stopped) return
    this.scheduled = true
    void this.poll()
    void taskManager().ensureEvery(RECURRING_POLL_JOB, this.pollTask.spec, { intervalMs: AGENT_STATUS_POLL_INTERVAL_MS })
  }

  stop(): void {
    this.stopped = true
    this.listeners.clear()
    this.pusher = null
    void taskManager().cancel(RECURRING_POLL_JOB)
    void taskManager().cancel(DEBOUNCED_POLL_JOB)
  }

  /**
   * Called with every list that differs from the one before it, and at once
   * with the current list when there is one (a tray shown later in the session).
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    if (this.agents) this.notify(listener, this.agents)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Whether a window's pushed list is in force, and so main is not polling. */
  get isPushed(): boolean {
    return this.pusher !== null
  }

  /**
   * Something on this computer's notification stream says the list may have
   * moved: fetch shortly, once per burst. A no-op while a window is pushing
   * (it heard the same thing first) and while the app drives the cloud
   * workspace (this stream says nothing about it).
   */
  requestRefresh(): void {
    if (!this.scheduled || this.stopped || this.pusher || this.lastTarget !== 'local') return
    // Each request replaces the last, so a burst ends in one fetch.
    void taskManager().at(Date.now() + AGENT_STATUS_DEBOUNCE_MS, DEBOUNCED_POLL_JOB, this.pollTask.spec)
  }

  /**
   * The app now drives the other Superagent. Whatever a window pushed was the
   * previous one's (the window is about to reload, and pushes again once it
   * has), so it is dropped and main asks the new target at once instead of
   * leaving the previous agents up until the next interval.
   */
  targetSwitched(): void {
    this.pusher = null
    this.pushSequence++
    void this.refresh()
  }

  /**
   * A list from the main window's renderer. Returns whether it is now in force.
   *
   * The payload is validated: in cloud mode it derives from remote data. It is
   * applied only if it is for the Superagent the app is driving, which a
   * document that has not yet reloaded after a target switch is not.
   */
  async acceptPush(sender: AgentStatusPusher, raw: unknown): Promise<boolean> {
    const sequence = ++this.pushSequence
    const parsed = agentStatusPushSchema.safeParse(raw)
    if (!parsed.success || parsed.data === null) {
      if (!parsed.success) console.warn('[AgentStatus] Ignoring a malformed agent list from the window')
      // Withdrawn, or no longer readable: either way that window's last list
      // is not being kept current any more.
      this.release(sender)
      return false
    }
    if (!this.deps || this.stopped || sender.isDestroyed()) return false

    let active: ApiTarget
    try {
      active = (await this.deps.activeTarget()).target
    } catch (error) {
      console.warn('[AgentStatus] Could not resolve the active target for a pushed list:', describe(error))
      this.release(sender)
      return false
    }
    if (sequence !== this.pushSequence || this.stopped || sender.isDestroyed()) return false
    if (active !== parsed.data.target) {
      this.release(sender)
      return false
    }

    this.watch(sender)
    this.pusher = sender
    this.lastTarget = active
    // Newer than any fetch in flight.
    this.generation++
    this.apply(parsed.data.agents)
    return true
  }

  /** One fetch from the API, unless a window is pushing. */
  private async poll(): Promise<void> {
    if (this.pusher) return
    await this.refresh()
  }

  private async refresh(): Promise<void> {
    const deps = this.deps
    if (!deps || this.stopped) return
    const generation = ++this.generation
    let agents: AgentInfo[]
    try {
      const { target, baseUrl } = await deps.activeTarget()
      if (generation === this.generation) this.lastTarget = target
      agents = await fetchAgentsWithStatus(baseUrl, deps.fetch)
    } catch (error) {
      // Listed as no agents, like an unreachable API: a pass must not reject.
      console.error('Failed to resolve the API base URL for the tray and the app menu:', error)
      agents = []
    }
    if (generation !== this.generation || this.stopped) return
    this.apply(agents)
  }

  /** The window's list is no longer kept current: go back to asking the API, starting now. */
  private release(sender: AgentStatusPusher): void {
    if (this.pusher !== sender) return
    this.pusher = null
    this.pushSequence++
    void this.refresh()
  }

  private watch(sender: AgentStatusPusher): void {
    if (this.watched.has(sender)) return
    this.watched.add(sender)
    const release = () => this.release(sender)
    sender.on('destroyed', release)
    sender.on('render-process-gone', release)
    // A reload or a navigation away: the document that pushed is gone, and
    // the next one pushes again only if it loads and its agents query answers.
    sender.on('did-start-navigation', (details) => {
      const navigation = details as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
      if (navigation?.isMainFrame && !navigation.isSameDocument) release()
    })
  }

  private apply(agents: AgentInfo[]): void {
    const key = listKey(agents)
    if (key === this.key) return
    this.key = key
    this.agents = agents
    for (const listener of [...this.listeners]) this.notify(listener, agents)
  }

  private notify(listener: Listener, agents: AgentInfo[]): void {
    try {
      listener(agents)
    } catch (error) {
      console.error('[AgentStatus] Failed to rebuild a menu:', error)
    }
  }
}

/** The app's one source. The tray and the app menu subscribe to it; `startAgentStatus` sets it going. */
export const agentStatusSource = new AgentStatusSource()

/** Start fetching. Call once the API is bound; the menus may subscribe before or after. */
export function startAgentStatus(deps: AgentStatusDeps): void {
  agentStatusSource.configure(deps)
  if (serviceHost().isRegistered(agentStatusSource.id)) return
  // Registered here rather than with the other services: like Spotlight, this
  // is a desktop feature that starts once the window and the API are up.
  serviceHost().register(agentStatusSource)
  serviceHost().startService(agentStatusSource.id).catch((error) => {
    console.error('[AgentStatus] Could not start:', error)
  })
}
