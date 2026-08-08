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

interface ReauthSettler {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type McpReauthEntry = Extract<PendingUserInputRequest, { kind: 'mcp_reauth_required' }>

/**
 * Parks MCP proxy requests while an inactive remote MCP is re-authorized.
 * The registry entry broadcasts the in-chat request; this class owns only the
 * in-memory promise that resumes the original HTTP request after reconnection.
 */
export class McpReauthManager {
  private settlers = new Map<string, ReauthSettler>()

  private static isMcpReauthEntry(
    request: PendingUserInputRequest,
  ): request is McpReauthEntry {
    return request.kind === 'mcp_reauth_required'
  }

  private settle(
    entry: McpReauthEntry,
    outcome: 'answered' | 'cancelled' | 'timeout',
    action: { type: 'resolve' } | { type: 'reject'; error: Error },
  ): void {
    const settler = this.settlers.get(entry.id)
    this.settlers.delete(entry.id)
    if (settler) clearTimeout(settler.timer)
    userInputRequestManager.resolve(entry.id, outcome)
    if (settler) {
      if (action.type === 'resolve') settler.resolve()
      else settler.reject(action.error)
    }
  }

  requestReauth(details: McpReauthDetails, signal?: AbortSignal): Promise<void> {
    const id = crypto.randomUUID()

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = userInputRequestManager.getOpenRequest(id)
        if (!entry || !McpReauthManager.isMcpReauthEntry(entry)) {
          const orphan = this.settlers.get(id)
          if (!orphan) return
          this.settlers.delete(id)
          orphan.reject(new Error('MCP re-authentication request was lost'))
          return
        }
        this.settle(entry, 'timeout', {
          type: 'reject',
          error: new Error('MCP re-authentication timed out'),
        })
        messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
      }, MCP_REAUTH_TIMEOUT_MS)

      this.settlers.set(id, { resolve, reject, timer })

      if (signal?.aborted) {
        clearTimeout(timer)
        this.settlers.delete(id)
        reject(new Error('MCP proxy request aborted while awaiting re-authentication'))
        return
      }

      if (signal) {
        signal.addEventListener('abort', () => {
          const entry = userInputRequestManager.getOpenRequest(id)
          if (!entry || !McpReauthManager.isMcpReauthEntry(entry)) return
          this.settle(entry, 'cancelled', {
            type: 'reject',
            error: new Error('MCP proxy request aborted while awaiting re-authentication'),
          })
          messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
        }, { once: true })
      }

      const registered = userInputRequestManager.register({
        id,
        kind: 'mcp_reauth_required',
        scope: { agentSlug: details.agentSlug },
        blocking: true,
        autoApproved: false,
        payload: {
          mcpId: details.mcpId,
          mcpName: details.mcpName,
          authType: details.authType,
          proxyRequestId: id,
        },
      })

      if (!registered) {
        clearTimeout(timer)
        this.settlers.delete(id)
        reject(new Error('Failed to register MCP re-authentication request'))
        return
      }

      messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
    })
  }

  /** Resume every parked proxy request that uses the reconnected MCP. */
  completeMcp(mcpId: string): number {
    const agentSlugs = new Set<string>()
    let completed = 0

    for (const request of userInputRequestManager.getOpenRequestsForStore('review')) {
      if (!McpReauthManager.isMcpReauthEntry(request)) continue
      const payload = request.payload as Record<string, unknown>
      if (payload.mcpId !== mcpId) continue
      if (request.scope.agentSlug) agentSlugs.add(request.scope.agentSlug)
      this.settle(request, 'answered', { type: 'resolve' })
      completed++
    }

    for (const agentSlug of agentSlugs) {
      messagePersister.syncAgentSessionsAwaiting(agentSlug)
    }
    return completed
  }

  rejectAll(): void {
    const agentSlugs = new Set<string>()
    for (const request of userInputRequestManager.getOpenRequestsForStore('review')) {
      if (!McpReauthManager.isMcpReauthEntry(request)) continue
      if (request.scope.agentSlug) agentSlugs.add(request.scope.agentSlug)
      this.settle(request, 'cancelled', {
        type: 'reject',
        error: new Error('MCP re-authentication interrupted by shutdown'),
      })
    }

    for (const [id, settler] of this.settlers) {
      clearTimeout(settler.timer)
      this.settlers.delete(id)
      settler.reject(new Error('MCP re-authentication interrupted by shutdown'))
    }

    for (const agentSlug of agentSlugs) {
      messagePersister.syncAgentSessionsAwaiting(agentSlug)
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
