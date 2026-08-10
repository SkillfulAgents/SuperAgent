import crypto from 'crypto'
import { messagePersister } from '@shared/lib/container/message-persister'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'

export const MCP_REAUTH_TIMEOUT_MS = 5 * 60 * 1000

export interface McpReauthDetails {
  agentSlug: string
  mcpId: string
  mcpName: string
  authType: 'none' | 'oauth' | 'bearer'
}

interface ReauthWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

interface McpReauthGroup {
  key: string
  entryId: string
  agentSlug: string
  mcpId: string
  waiters: Set<ReauthWaiter>
}

type McpReauthEntry = Extract<PendingUserInputRequest, { kind: 'mcp_reauth_required' }>

/**
 * Parks MCP proxy requests while an inactive remote MCP is re-authorized.
 * The registry entry broadcasts the in-chat request; this class owns only the
 * in-memory promise that resumes the original HTTP request after reconnection.
 */
export class McpReauthManager {
  private groups = new Map<string, McpReauthGroup>()
  private entryIdByKey = new Map<string, string>()

  private static isMcpReauthEntry(
    request: PendingUserInputRequest,
  ): request is McpReauthEntry {
    return request.kind === 'mcp_reauth_required'
  }

  private cleanupWaiter(waiter: ReauthWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  private settleGroup(
    group: McpReauthGroup,
    outcome: 'answered' | 'cancelled' | 'timeout',
    action: { type: 'resolve' } | { type: 'reject'; error: Error },
  ): number {
    this.groups.delete(group.entryId)
    if (this.entryIdByKey.get(group.key) === group.entryId) {
      this.entryIdByKey.delete(group.key)
    }
    const entry = userInputRequestManager.getOpenRequest(group.entryId)
    if (entry && McpReauthManager.isMcpReauthEntry(entry)) {
      userInputRequestManager.resolve(entry.id, outcome)
    }

    const waiters = [...group.waiters]
    group.waiters.clear()
    for (const waiter of waiters) {
      this.cleanupWaiter(waiter)
      if (action.type === 'resolve') waiter.resolve()
      else waiter.reject(action.error)
    }
    messagePersister.syncAgentSessionsAwaiting(group.agentSlug)
    return waiters.length
  }

  private rejectWaiter(
    group: McpReauthGroup,
    waiter: ReauthWaiter,
    outcome: 'cancelled' | 'timeout',
    error: Error,
  ): void {
    if (!group.waiters.delete(waiter)) return
    this.cleanupWaiter(waiter)
    waiter.reject(error)
    if (group.waiters.size > 0) return

    this.groups.delete(group.entryId)
    if (this.entryIdByKey.get(group.key) === group.entryId) {
      this.entryIdByKey.delete(group.key)
    }
    const entry = userInputRequestManager.getOpenRequest(group.entryId)
    if (entry && McpReauthManager.isMcpReauthEntry(entry)) {
      userInputRequestManager.resolve(entry.id, outcome)
    }
    messagePersister.syncAgentSessionsAwaiting(group.agentSlug)
  }

  requestReauth(details: McpReauthDetails, signal?: AbortSignal): Promise<void> {
    const key = `${details.agentSlug}\0${details.mcpId}`
    const existingId = this.entryIdByKey.get(key)
    let group = existingId ? this.groups.get(existingId) : undefined
    let isNewGroup = false

    if (group) {
      const entry = userInputRequestManager.getOpenRequest(group.entryId)
      if (!entry || !McpReauthManager.isMcpReauthEntry(entry)) {
        this.settleGroup(group, 'cancelled', {
          type: 'reject',
          error: new Error('MCP re-authentication request was lost'),
        })
        group = undefined
      }
    }

    if (!group) {
      if (existingId) this.entryIdByKey.delete(key)
      const entryId = crypto.randomUUID()
      group = {
        key,
        entryId,
        agentSlug: details.agentSlug,
        mcpId: details.mcpId,
        waiters: new Set(),
      }
      this.groups.set(entryId, group)
      this.entryIdByKey.set(key, entryId)
      isNewGroup = true
    }

    const activeGroup = group

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        if (isNewGroup && activeGroup.waiters.size === 0) {
          this.groups.delete(activeGroup.entryId)
          this.entryIdByKey.delete(activeGroup.key)
        }
        reject(new Error('MCP proxy request aborted while awaiting re-authentication'))
        return
      }

      let waiter: ReauthWaiter
      const timer = setTimeout(() => {
        this.rejectWaiter(
          activeGroup,
          waiter,
          'timeout',
          new Error('MCP re-authentication timed out'),
        )
      }, MCP_REAUTH_TIMEOUT_MS)

      waiter = { resolve, reject, timer, signal }
      if (signal) {
        waiter.onAbort = () => {
          this.rejectWaiter(
            activeGroup,
            waiter,
            'cancelled',
            new Error('MCP proxy request aborted while awaiting re-authentication'),
          )
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      activeGroup.waiters.add(waiter)

      if (!isNewGroup) return

      const registered = userInputRequestManager.register({
        id: activeGroup.entryId,
        kind: 'mcp_reauth_required',
        scope: { agentSlug: details.agentSlug },
        blocking: true,
        autoApproved: false,
        payload: {
          mcpId: details.mcpId,
          mcpName: details.mcpName,
          authType: details.authType,
          proxyRequestId: activeGroup.entryId,
        },
      })

      if (!registered) {
        this.settleGroup(activeGroup, 'cancelled', {
          type: 'reject',
          error: new Error('Failed to register MCP re-authentication request'),
        })
        return
      }

      messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
    })
  }

  /** Resume every parked proxy request that uses the reconnected MCP. */
  completeMcp(mcpId: string): number {
    let completed = 0
    for (const group of [...this.groups.values()]) {
      if (group.mcpId !== mcpId) continue
      completed += this.settleGroup(group, 'answered', { type: 'resolve' })
    }
    return completed
  }

  rejectAll(): void {
    for (const group of [...this.groups.values()]) {
      this.settleGroup(group, 'cancelled', {
        type: 'reject',
        error: new Error('MCP re-authentication interrupted by shutdown'),
      })
    }
  }
}

const globalForMcpReauthManager = globalThis as unknown as {
  mcpReauthManager: McpReauthManager | undefined
}

export const mcpReauthManager =
  globalForMcpReauthManager.mcpReauthManager ?? new McpReauthManager()

if (process.env.NODE_ENV !== 'production') {
  globalForMcpReauthManager.mcpReauthManager = mcpReauthManager
}
