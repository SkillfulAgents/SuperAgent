import crypto from 'crypto'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { AgentInputRequests } from '@shared/lib/user-input/agent-input-requests'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'
import { ReauthDismissedError, reauthDismissedMessage } from './reauth-dismissal'
import { AccountReplacedError } from './account-replacement'
import { McpReplacedError } from './mcp-replacement'

/**
 * Parks one agent's proxy requests while a connection they depend on — an
 * expired or revoked account, an inactive remote MCP — is re-authorized.
 *
 * The agent's user-input store is the durable announcement channel:
 * registering a `*_reauth_required` envelope broadcasts the unified SSE
 * created event and keeps every session of the agent in the awaiting-input
 * state. This class owns only the in-memory promise settlers that let the
 * original HTTP requests resume once the connection is active again — one
 * card per subject (account or MCP), shared by every request parked on it.
 *
 * Owned by the agent's actor: a wait can only ever be for this agent, and
 * dropping the actor rejects whatever is still parked. The account and MCP
 * flavours differ only in their spec, below.
 */

export type ReauthWaitKind = Extract<PendingUserInputRequest['kind'], `${string}_reauth_required`>

/** What distinguishes the account and MCP flavours of a re-auth wait. */
export interface ReauthWaitSpec<Details> {
  kind: ReauthWaitKind
  /** The connection the wait is for; one open card per subject. */
  subjectOf(details: Details): string
  /** The envelope payload that renders the card. */
  payloadOf(details: Details, entryId: string): Record<string, unknown>
  timeoutMs: number
  /** For the dismissal error, e.g. 'Account re-authentication'. */
  label: string
  messages: {
    lost: string
    timeout: string
    aborted: string
    shutdown: string
    registerFailed: string
  }
  /** The error a parked request resumes with when its subject was replaced by another connection. */
  replaced(replacementId: string): Error
}

interface ReauthWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

interface ReauthGroup {
  subject: string
  entryId: string
  waiters: Set<ReauthWaiter>
}

type ReauthOutcome = 'answered' | 'cancelled' | 'timeout'

export class AgentReauthWaits<Details> {
  private groups = new Map<string, ReauthGroup>()
  private entryIdBySubject = new Map<string, string>()

  constructor(
    readonly slug: AgentSlug,
    private readonly inputs: AgentInputRequests,
    /** Recompute the agent's sessions' awaiting state after a card opens or closes. */
    private readonly syncAwaiting: () => void,
    private readonly spec: ReauthWaitSpec<Details>,
  ) {}

  private isOwnEntry(request: PendingUserInputRequest): boolean {
    return request.kind === this.spec.kind
  }

  private cleanupWaiter(waiter: ReauthWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  private forgetGroup(group: ReauthGroup): void {
    this.groups.delete(group.entryId)
    if (this.entryIdBySubject.get(group.subject) === group.entryId) {
      this.entryIdBySubject.delete(group.subject)
    }
  }

  private resolveEntry(group: ReauthGroup, outcome: ReauthOutcome): void {
    const entry = this.inputs.getOpenRequest(group.entryId)
    if (entry && this.isOwnEntry(entry)) {
      this.inputs.resolve(entry.id, outcome)
    }
  }

  private settleGroup(
    group: ReauthGroup,
    outcome: ReauthOutcome,
    action: { type: 'resolve' } | { type: 'reject'; error: Error },
  ): number {
    this.forgetGroup(group)
    this.resolveEntry(group, outcome)

    const waiters = [...group.waiters]
    group.waiters.clear()
    for (const waiter of waiters) {
      this.cleanupWaiter(waiter)
      if (action.type === 'resolve') waiter.resolve()
      else waiter.reject(action.error)
    }
    this.syncAwaiting()
    return waiters.length
  }

  private rejectWaiter(
    group: ReauthGroup,
    waiter: ReauthWaiter,
    outcome: 'cancelled' | 'timeout',
    error: Error,
  ): void {
    if (!group.waiters.delete(waiter)) return
    this.cleanupWaiter(waiter)
    waiter.reject(error)

    // Keep the shared card open while another HTTP request is still parked on
    // the same connection. The final waiter owns the entry's resolution.
    if (group.waiters.size > 0) return

    this.forgetGroup(group)
    this.resolveEntry(group, outcome)
    this.syncAwaiting()
  }

  /**
   * Park a request until the subject is re-authorized. Requests on the same
   * subject share one card; completing the subject resumes all of them.
   */
  request(details: Details, signal?: AbortSignal): Promise<void> {
    const subject = this.spec.subjectOf(details)
    const existingId = this.entryIdBySubject.get(subject)
    let group = existingId ? this.groups.get(existingId) : undefined
    let isNewGroup = false

    if (group) {
      const entry = this.inputs.getOpenRequest(group.entryId)
      if (!entry || !this.isOwnEntry(entry)) {
        this.settleGroup(group, 'cancelled', {
          type: 'reject',
          error: new Error(this.spec.messages.lost),
        })
        group = undefined
      }
    }

    if (!group) {
      if (existingId) this.entryIdBySubject.delete(subject)
      const entryId = crypto.randomUUID()
      group = { subject, entryId, waiters: new Set() }
      this.groups.set(entryId, group)
      this.entryIdBySubject.set(subject, entryId)
      isNewGroup = true
    }

    const activeGroup = group

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        if (isNewGroup && activeGroup.waiters.size === 0) {
          this.groups.delete(activeGroup.entryId)
          this.entryIdBySubject.delete(activeGroup.subject)
        }
        reject(new Error(this.spec.messages.aborted))
        return
      }

      let waiter: ReauthWaiter
      const timer = setTimeout(() => {
        this.rejectWaiter(activeGroup, waiter, 'timeout', new Error(this.spec.messages.timeout))
      }, this.spec.timeoutMs)

      waiter = { resolve, reject, timer, signal }
      if (signal) {
        waiter.onAbort = () => {
          this.rejectWaiter(activeGroup, waiter, 'cancelled', new Error(this.spec.messages.aborted))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      activeGroup.waiters.add(waiter)

      if (!isNewGroup) return

      const registered = this.inputs.register({
        id: activeGroup.entryId,
        kind: this.spec.kind,
        scope: { agentSlug: this.slug },
        blocking: true,
        autoApproved: false,
        payload: this.spec.payloadOf(details, activeGroup.entryId),
      })

      if (!registered) {
        this.settleGroup(activeGroup, 'cancelled', {
          type: 'reject',
          error: new Error(this.spec.messages.registerFailed),
        })
        return
      }

      this.syncAwaiting()
    })
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
    this.settleGroup(group, 'cancelled', {
      type: 'reject',
      error: new ReauthDismissedError(reauthDismissedMessage(this.spec.label, reason), reason),
    })
    return true
  }

  /** Settle the wait with a different connection: the parked calls must not resume against the old one. */
  replace(entryId: string, replacementId: string): boolean {
    const group = this.groups.get(entryId)
    if (!group) return false
    this.settleGroup(group, 'answered', { type: 'reject', error: this.spec.replaced(replacementId) })
    return true
  }

  /** Resume every parked request on the reconnected subject; returns how many. */
  complete(subject: string): number {
    let completed = 0
    for (const group of [...this.groups.values()]) {
      if (group.subject !== subject) continue
      completed += this.settleGroup(group, 'answered', { type: 'resolve' })
    }
    return completed
  }

  /** Every open card's entry id, for tests and sweeps. */
  openEntryIds(): string[] {
    return [...this.groups.keys()]
  }

  /** Reject everything still parked: the process is shutting down, or the agent is gone. */
  rejectAll(error: Error = new Error(this.spec.messages.shutdown)): void {
    for (const group of [...this.groups.values()]) {
      this.settleGroup(group, 'cancelled', { type: 'reject', error })
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
  label: 'Account re-authentication',
  messages: {
    lost: 'Account re-authentication request was lost',
    timeout: 'Account re-authentication timed out',
    aborted: 'Proxy request aborted while awaiting re-authentication',
    shutdown: 'Account re-authentication interrupted by shutdown',
    registerFailed: 'Failed to register account re-authentication request',
  },
  replaced: (replacementAccountId) => new AccountReplacedError(replacementAccountId),
}

/** One agent's parked proxy requests awaiting an account's re-authorization. */
export type AccountReauthWaits = AgentReauthWaits<AccountReauthRequest>

export function createAccountReauthWaits(
  slug: AgentSlug,
  inputs: AgentInputRequests,
  syncAwaiting: () => void,
): AccountReauthWaits {
  return new AgentReauthWaits(slug, inputs, syncAwaiting, ACCOUNT_REAUTH_SPEC)
}

// ── Remote MCPs ─────────────────────────────────────────────────────────────

export const MCP_REAUTH_TIMEOUT_MS = 5 * 60 * 1000

export interface McpReauthDetails {
  agentSlug: string
  mcpId: string
  mcpName: string
  authType: 'none' | 'oauth' | 'bearer'
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
  label: 'MCP re-authentication',
  messages: {
    lost: 'MCP re-authentication request was lost',
    timeout: 'MCP re-authentication timed out',
    aborted: 'MCP proxy request aborted while awaiting re-authentication',
    shutdown: 'MCP re-authentication interrupted by shutdown',
    registerFailed: 'Failed to register MCP re-authentication request',
  },
  replaced: (replacementMcpId) => new McpReplacedError(replacementMcpId),
}

/** One agent's parked MCP proxy requests awaiting a remote MCP's re-authorization. */
export type McpReauthWaits = AgentReauthWaits<McpReauthRequest>

export function createMcpReauthWaits(
  slug: AgentSlug,
  inputs: AgentInputRequests,
  syncAwaiting: () => void,
): McpReauthWaits {
  return new AgentReauthWaits(slug, inputs, syncAwaiting, MCP_REAUTH_SPEC)
}
