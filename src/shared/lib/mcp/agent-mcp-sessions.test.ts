import { describe, expect, it } from 'vitest'
import { AgentMcpSessions } from './agent-mcp-sessions'

const DAY_MS = 24 * 60 * 60 * 1000

describe('AgentMcpSessions', () => {
  it('a session is found only for the MCP it was opened for, unbound until bound', () => {
    const sessions = new AgentMcpSessions()
    const id = sessions.open('mcp-1', '2025-06-18', 0)
    expect(sessions.get('mcp-2', id, 1)).toBeNull()
    expect(sessions.get('mcp-1', 'unknown', 1)).toBeNull()
    expect(sessions.get('mcp-1', id, 1)).toEqual({ protocolVersion: '2025-06-18', upstreamSessionId: undefined })

    sessions.bind(id, 'upstream-1', 2)
    expect(sessions.get('mcp-1', id, 3)?.upstreamSessionId).toBe('upstream-1')
    // A stateless upstream binds to null: bound, with no id to send.
    sessions.bind(id, null, 4)
    expect(sessions.get('mcp-1', id, 5)?.upstreamSessionId).toBeNull()
    sessions.unbind(id)
    expect(sessions.get('mcp-1', id, 6)?.upstreamSessionId).toBeUndefined()

    sessions.close(id)
    expect(sessions.get('mcp-1', id, 7)).toBeNull()
  })

  it('a session unused for a day expires; using it keeps it', () => {
    const sessions = new AgentMcpSessions()
    const kept = sessions.open('mcp-1', 'v', 0)
    const dropped = sessions.open('mcp-1', 'v', 0)
    expect(sessions.get('mcp-1', kept, DAY_MS - 1)).not.toBeNull()
    expect(sessions.get('mcp-1', dropped, DAY_MS + 1)).toBeNull()
    expect(sessions.get('mcp-1', kept, 2 * DAY_MS - 2)).not.toBeNull()
  })

  it('opening a session prunes the expired ones', () => {
    const sessions = new AgentMcpSessions()
    const old = sessions.open('mcp-1', 'v', 0)
    sessions.open('mcp-1', 'v', DAY_MS + 1)
    // Read at a time it would still be fresh: it is gone all the same.
    expect(sessions.get('mcp-1', old, 1)).toBeNull()
  })
})
