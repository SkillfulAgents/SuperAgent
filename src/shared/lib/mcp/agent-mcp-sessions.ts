/**
 * The MCP sessions the proxy opened on one agent's behalf.
 *
 * While a remote MCP's credentials are known to be bad, the proxy answers the
 * client's `initialize` itself and hands it a session id of its own, so the
 * SDK keeps sending one after re-authentication. That client-facing id is
 * bound to a real upstream session lazily, once fresh credentials exist; a
 * 401 unbinds it so the next request initializes again. Unused sessions
 * expire after a day.
 */
import { randomUUID } from 'crypto'

const SESSION_TTL_MS = 24 * 60 * 60 * 1000

/** A proxy-opened session as a request sees it. */
export interface McpProxySession {
  protocolVersion: string
  /** The upstream session it speaks for: undefined until bound, null when the upstream is stateless. */
  upstreamSessionId: string | null | undefined
}

interface Entry extends McpProxySession {
  mcpId: string
  lastUsedAt: number
}

export class AgentMcpSessions {
  private sessions = new Map<string, Entry>()

  /** Open a session for `mcpId`: the id the client sends back. */
  open(mcpId: string, protocolVersion: string, now = Date.now()): string {
    this.prune(now)
    const id = randomUUID()
    this.sessions.set(id, { mcpId, protocolVersion, upstreamSessionId: undefined, lastUsedAt: now })
    return id
  }

  /** The session `id` if it is this MCP's and still in use; reading it counts as use. */
  get(mcpId: string, id: string, now = Date.now()): McpProxySession | null {
    const entry = this.sessions.get(id)
    if (!entry || entry.mcpId !== mcpId) return null
    if (now - entry.lastUsedAt > SESSION_TTL_MS) {
      this.sessions.delete(id)
      return null
    }
    entry.lastUsedAt = now
    return { protocolVersion: entry.protocolVersion, upstreamSessionId: entry.upstreamSessionId }
  }

  /** The upstream session `id` now speaks for (null: the upstream is stateless). */
  bind(id: string, upstreamSessionId: string | null, now = Date.now()): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    entry.upstreamSessionId = upstreamSessionId
    entry.lastUsedAt = now
  }

  /** Forget the upstream session: the next request initializes a new one. */
  unbind(id: string): void {
    const entry = this.sessions.get(id)
    if (entry) entry.upstreamSessionId = undefined
  }

  close(id: string): void {
    this.sessions.delete(id)
  }

  clear(): void {
    this.sessions.clear()
  }

  private prune(now: number): void {
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > SESSION_TTL_MS) this.sessions.delete(id)
    }
  }
}
