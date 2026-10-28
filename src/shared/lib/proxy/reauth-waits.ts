import crypto from 'crypto'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { AgentInputRequests } from '@shared/lib/tools/requests/agent-input-requests'
import type { PendingUserInputRequest } from '@shared/lib/tools/requests/request-schema'

/**
 * Parks one agent's proxy requests while a connection they depend on — an
 * expired or revoked account, an inactive remote MCP — is re-authorized.
 *
 * The agent's user-input store is the durable announcement channel:
 * registering a `*_reauth_required` envelope broadcasts the unified SSE
 * created event and keeps the session that made the call in the
 * awaiting-input state — every session of the agent when that session is
 * unknown or not running. This class owns only the in-memory promise
 * settlers that let the original HTTP requests resume once the connection is
 * active again — one card per subject (account or MCP) and session, shared by
 * every request parked on it.
 *
 * Owned by the agent's actor: a wait can only ever be for this agent, and
 * dropping the actor ends whatever is still parked. A wait ends as data
 * (`ReauthOutcome`); the caller withdraws its own by the id it chose. The account and MCP
 * flavours differ only in their spec, below.
 */

export type ReauthWaitKind = Extract<PendingUserInputRequest['kind'], `${string}_reauth_required`>

/** What distinguishes the account and MCP flavours of a re-auth wait. */
export interface ReauthWaitSpec<Details> {
  kind: ReauthWaitKind
  /** The connection the wait is for; one open card per subject and session. */
  subjectOf(details: Details): string
  /** The envelope payload that renders the card. */
  payloadOf(details: Details, entryId: string): Record<string, unknown>
  timeoutMs: number
  /** Why a wait was cancelled, as `cancelled` outcomes carry it. */
  messages: {
    lost: string
    shutdown: string
    registerFailed: string
  }
}

/**
 * How a parked request's wait ends, as data:
 * - `resumed`: the subject was re-authorized; retry the call;
 * - `replaced`: a person replaced the subject with another connection;
 * - `dismissed`: a person dismissed the card, with what they typed;
 * - `timeout`: nobody acted in time;
 * - `withdrawn`: the caller withdrew it (its request was aborted);
 * - `cancelled`: the wait could not be kept (the card was lost or never
 *   registered, the process is shutting down, the agent is gone).
 */
export type ReauthOutcome =
  | { outcome: 'resumed' }
  | { outcome: 'replaced'; replacementId: string }
  | { outcome: 'dismissed'; reason?: string }
  | { outcome: 'timeout' }
  | { outcome: 'withdrawn' }
  | { outcome: 'cancelled'; message: string }

interface ReauthWaiter {
  waitId: string
  settle: (outcome: ReauthOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

interface ReauthGroup {
  subject: string
  /** The session the card is scoped to; absent when it blocks the whole agent. */
  sessionId?: string
  key: string
  entryId: string
  waiters: Set<ReauthWaiter>
}

type ReauthEntryOutcome = 'answered' | 'cancelled' | 'timeout'

const cardKey = (subject: string, sessionId: string | undefined) => JSON.stringify([subject, sessionId ?? null])

export class AgentReauthWaits<Details extends { callerSessionId?: string }> {
  private groups = new Map<string, ReauthGroup>()
  private entryIdByCard = new Map<string, string>()
  /** Each parked call's waiter and the card it waits on, by the caller's wait id. */
  private waiters = new Map<string, { group: ReauthGroup; waiter: ReauthWaiter }>()

  constructor(
    readonly slug: AgentSlug,
    private readonly inputs: AgentInputRequests,
    /** Recompute the agent's sessions' awaiting state after a card opens or closes. */
    private readonly syncAwaiting: () => void,
    /** The session a card is scoped to, or undefined to scope it to the agent. See `createAgentState`. */
    private readonly cardSession: (callerSessionId: string | undefined) => string | undefined,
    private readonly spec: ReauthWaitSpec<Details>,
  ) {}

  private isOwnEntry(request: PendingUserInputRequest): boolean {
    return request.kind === this.spec.kind
  }

  private forgetGroup(group: ReauthGroup): void {
    this.groups.delete(group.entryId)
    if (this.entryIdByCard.get(group.key) === group.entryId) {
      this.entryIdByCard.delete(group.key)
    }
  }

  private resolveEntry(group: ReauthGroup, outcome: ReauthEntryOutcome): void {
    const entry = this.inputs.getOpenRequest(group.entryId)
    if (entry && this.isOwnEntry(entry)) {
      this.inputs.resolve(entry.id, outcome)
    }
  }

  private release(waiter: ReauthWaiter, outcome: ReauthOutcome): void {
    clearTimeout(waiter.timer)
    this.waiters.delete(waiter.waitId)
    waiter.settle(outcome)
  }

  private settleGroup(group: ReauthGroup, entryOutcome: ReauthEntryOutcome, outcome: ReauthOutcome): number {
    this.forgetGroup(group)
    this.resolveEntry(group, entryOutcome)

    const waiters = [...group.waiters]
    group.waiters.clear()
    for (const waiter of waiters) this.release(waiter, outcome)
    this.syncAwaiting()
    return waiters.length
  }

  /** One parked call leaves its group; the last one closes the shared card. */
  private leave(group: ReauthGroup, waiter: ReauthWaiter, entryOutcome: 'cancelled' | 'timeout', outcome: ReauthOutcome): void {
    if (!group.waiters.delete(waiter)) return
    this.release(waiter, outcome)

    // Keep the shared card open while another HTTP request is still parked on
    // the same connection. The final waiter owns the entry's resolution.
    if (group.waiters.size > 0) return

    this.forgetGroup(group)
    this.resolveEntry(group, entryOutcome)
    this.syncAwaiting()
  }

  /** The group holding a card key, if its card is still open; a group whose card was lost is cancelled. */
  private openGroup(key: string): ReauthGroup | undefined {
    const entryId = this.entryIdByCard.get(key)
    const group = entryId ? this.groups.get(entryId) : undefined
    if (!group) {
      if (entryId) this.entryIdByCard.delete(key)
      return undefined
    }
    const entry = this.inputs.getOpenRequest(group.entryId)
    if (entry && this.isOwnEntry(entry)) return group
    this.settleGroup(group, 'cancelled', { outcome: 'cancelled', message: this.spec.messages.lost })
    return undefined
  }

  /**
   * Park a request until the subject is re-authorized, under the caller's
   * `waitId` (to withdraw it). Requests on the same subject share the card
   * their session shows; completing the subject resumes all of them, in
   * every session.
   */
  request(details: Details, options: { waitId: string }): Promise<ReauthOutcome> {
    const subject = this.spec.subjectOf(details)
    // Join a card the calling session already shows for this subject: its own
    // (even after its turn ended) or the agent-wide one. Only then open a new
    // card, scoped by whether the session is running now.
    let group =
      (details.callerSessionId ? this.openGroup(cardKey(subject, details.callerSessionId)) : undefined) ??
      this.openGroup(cardKey(subject, undefined))
    let isNewGroup = false

    if (!group) {
      const sessionId = this.cardSession(details.callerSessionId)
      const key = cardKey(subject, sessionId)
      const entryId = crypto.randomUUID()
      group = { subject, sessionId, key, entryId, waiters: new Set() }
      this.groups.set(entryId, group)
      this.entryIdByCard.set(key, entryId)
      isNewGroup = true
    }

    const activeGroup = group

    return new Promise<ReauthOutcome>((resolve) => {
      let waiter: ReauthWaiter
      const timer = setTimeout(() => {
        this.leave(activeGroup, waiter, 'timeout', { outcome: 'timeout' })
      }, this.spec.timeoutMs)

      waiter = { waitId: options.waitId, settle: resolve, timer }
      activeGroup.waiters.add(waiter)
      this.waiters.set(options.waitId, { group: activeGroup, waiter })

      if (!isNewGroup) return

      const registered = this.inputs.register({
        id: activeGroup.entryId,
        kind: this.spec.kind,
        scope: activeGroup.sessionId
          ? { agentSlug: this.slug, sessionId: activeGroup.sessionId }
          : { agentSlug: this.slug },
        blocking: true,
        autoApproved: false,
        payload: this.spec.payloadOf(details, activeGroup.entryId),
      })

      if (!registered) {
        this.settleGroup(activeGroup, 'cancelled', { outcome: 'cancelled', message: this.spec.messages.registerFailed })
        return
      }

      this.syncAwaiting()
    })
  }

  /** The caller is gone (its request was aborted): its call leaves the card, `withdrawn`. */
  withdraw(waitId: string): void {
    const parked = this.waiters.get(waitId)
    if (parked) this.leave(parked.group, parked.waiter, 'cancelled', { outcome: 'withdrawn' })
  }

  /**
   * Give up on one parked card because a person dismissed it. Without this the
   * only exits are the owner reconnecting or the timer, so a shared connection
   * nobody present can reconnect holds every session of the agent in
   * awaiting-input until it expires.
   *
   * Returns false when `entryId` names no live group — the caller decides
   * whether that is a stale card or a probe.
   */
  dismiss(entryId: string, reason?: string): boolean {
    const group = this.groups.get(entryId)
    if (!group) return false
    this.settleGroup(group, 'cancelled', { outcome: 'dismissed', ...(reason ? { reason } : {}) })
    return true
  }

  /**
   * Settle the wait with a different connection: the agent's parked calls on
   * the old one, in every session, must not resume against it.
   */
  replace(entryId: string, replacementId: string): boolean {
    const group = this.groups.get(entryId)
    if (!group) return false
    for (const sibling of [...this.groups.values()]) {
      if (sibling.subject !== group.subject) continue
      this.settleGroup(sibling, 'answered', { outcome: 'replaced', replacementId })
    }
    return true
  }

  /** The session was deleted or stopped: dismiss the calls parked on its own cards. */
  dropSession(sessionId: string, reason = 'The session was deleted.'): void {
    for (const group of [...this.groups.values()]) {
      if (group.sessionId !== sessionId) continue
      this.dismiss(group.entryId, reason)
    }
  }

  /** Resume every parked request on the reconnected subject; returns how many. */
  complete(subject: string): number {
    let completed = 0
    for (const group of [...this.groups.values()]) {
      if (group.subject !== subject) continue
      completed += this.settleGroup(group, 'answered', { outcome: 'resumed' })
    }
    return completed
  }

  /** Every open card's entry id, for tests and sweeps. */
  openEntryIds(): string[] {
    return [...this.groups.keys()]
  }

  /** End everything still parked: the process is shutting down, or the agent is gone. */
  rejectAll(message: string = this.spec.messages.shutdown): void {
    for (const group of [...this.groups.values()]) {
      this.settleGroup(group, 'cancelled', { outcome: 'cancelled', message })
    }
  }
}

// ── Connected accounts ──────────────────────────────────────────────────────

export const ACCOUNT_REAUTH_TIMEOUT_MS = 5 * 60 * 1000

export interface AccountReauthDetails {
  agentSlug: string
  accountId: string
  toolkit: string
  accountStatus: 'expired' | 'revoked'
  /** The session the proxied call came from, when the request named one. */
  callerSessionId?: string
}

/** What one agent's wait needs to know; the agent itself is the store's. */
export type AccountReauthRequest = Omit<AccountReauthDetails, 'agentSlug'>

const ACCOUNT_REAUTH_SPEC: ReauthWaitSpec<AccountReauthRequest> = {
  kind: 'account_reauth_required',
  subjectOf: (details) => details.accountId,
  payloadOf: (details, entryId) => ({
    accountId: details.accountId,
    toolkit: details.toolkit,
    accountStatus: details.accountStatus,
    proxyRequestId: entryId,
  }),
  timeoutMs: ACCOUNT_REAUTH_TIMEOUT_MS,
  messages: {
    lost: 'Account re-authentication request was lost',
    shutdown: 'Account re-authentication interrupted by shutdown',
    registerFailed: 'Failed to register account re-authentication request',
  },
}

/** One agent's parked proxy requests awaiting an account's re-authorization. */
export type AccountReauthWaits = AgentReauthWaits<AccountReauthRequest>

export function createAccountReauthWaits(
  slug: AgentSlug,
  inputs: AgentInputRequests,
  syncAwaiting: () => void,
  cardSession: (callerSessionId: string | undefined) => string | undefined,
): AccountReauthWaits {
  return new AgentReauthWaits(slug, inputs, syncAwaiting, cardSession, ACCOUNT_REAUTH_SPEC)
}

// ── Remote MCPs ─────────────────────────────────────────────────────────────

export const MCP_REAUTH_TIMEOUT_MS = 5 * 60 * 1000

export interface McpReauthDetails {
  agentSlug: string
  mcpId: string
  mcpName: string
  authType: 'none' | 'oauth' | 'bearer'
  /** The session the MCP call came from, when the request named one. */
  callerSessionId?: string
}

/** What one agent's wait needs to know; the agent itself is the store's. */
export type McpReauthRequest = Omit<McpReauthDetails, 'agentSlug'>

const MCP_REAUTH_SPEC: ReauthWaitSpec<McpReauthRequest> = {
  kind: 'mcp_reauth_required',
  subjectOf: (details) => details.mcpId,
  payloadOf: (details, entryId) => ({
    mcpId: details.mcpId,
    mcpName: details.mcpName,
    authType: details.authType,
    proxyRequestId: entryId,
  }),
  timeoutMs: MCP_REAUTH_TIMEOUT_MS,
  messages: {
    lost: 'MCP re-authentication request was lost',
    shutdown: 'MCP re-authentication interrupted by shutdown',
    registerFailed: 'Failed to register MCP re-authentication request',
  },
}

/** One agent's parked MCP proxy requests awaiting a remote MCP's re-authorization. */
export type McpReauthWaits = AgentReauthWaits<McpReauthRequest>

export function createMcpReauthWaits(
  slug: AgentSlug,
  inputs: AgentInputRequests,
  syncAwaiting: () => void,
  cardSession: (callerSessionId: string | undefined) => string | undefined,
): McpReauthWaits {
  return new AgentReauthWaits(slug, inputs, syncAwaiting, cardSession, MCP_REAUTH_SPEC)
}
