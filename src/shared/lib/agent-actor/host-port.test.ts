import { describe, expect, it, vi } from 'vitest'
import { createLocalHostPort, hostToolNameOf, HOST_TOOL_NAMES, type HostCallHandlers, type HostEventHandlers } from './host-port'

function handlers(events: Partial<HostEventHandlers> = {}, calls: Partial<HostCallHandlers> = {}) {
  return {
    calls: {
      hostTool: vi.fn(async () => ({ status: 'resolved' as const, value: 'done' })),
      computerUse: vi.fn(async () => 'ok'),
      computerUsePermissions: vi.fn(async () => null),
      computerUseWindowApp: vi.fn(async () => undefined),
      computerUseAppIcon: vi.fn(async () => null),
      hostScript: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      loginRequest: vi.fn(async () => ({ action: 'none' as const })),
      ...calls,
    },
    events: {
      global: vi.fn(),
      notification: vi.fn(),
      analytics: vi.fn(),
      ...events,
    },
  }
}

describe('createLocalHostPort', () => {
  it('answers a call with its handler', async () => {
    const h = handlers()
    const port = createLocalHostPort(h)
    const request = { agentSlug: 'a', sessionId: 's', toolUseId: 't', toolName: 'list_triggers' as const, input: '{}' }

    await expect(port.call('hostTool', request)).resolves.toEqual({ status: 'resolved', value: 'done' })
    expect(h.calls.hostTool).toHaveBeenCalledWith(request)
  })

  it('passes a call\'s failure back to the caller', async () => {
    const port = createLocalHostPort(handlers({}, { computerUse: async () => { throw new Error('no window') } }))
    await expect(port.call('computerUse', { method: 'click', params: {} })).rejects.toThrow('no window')
  })

  it('runs each send before returning, in the order sent', () => {
    const seen: string[] = []
    const port = createLocalHostPort(handlers({
      global: (event) => { seen.push(`global:${event.type}`) },
      analytics: ({ event }) => { seen.push(`analytics:${event}`) },
    }))

    port.send('global', { type: 'session_active' })
    port.send('analytics', { event: 'agent_requested_input' })
    port.send('global', { type: 'session_idle' })

    expect(seen).toEqual(['global:session_active', 'analytics:agent_requested_input', 'global:session_idle'])
  })

  it('never lets a send handler\'s failure reach the sender', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const port = createLocalHostPort(handlers({
      global: () => { throw new Error('listener broke') },
      notification: async () => { throw new Error('db locked') },
    }))

    expect(() => port.send('global', { type: 'session_idle' })).not.toThrow()
    expect(() => port.send('notification', {
      kind: 'session_waiting_input',
      agentSlug: 'a',
      sessionId: 's',
      request: { kind: 'question', payload: {} },
    })).not.toThrow()
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2))
    expect(errors.mock.calls.map(([message]) => message)).toEqual([
      "[HostPort] 'global' handler failed:",
      "[HostPort] 'notification' handler failed:",
    ])
    errors.mockRestore()
  })
})

describe('hostToolNameOf', () => {
  it('names the host tool a streamed tool name calls', () => {
    for (const name of HOST_TOOL_NAMES) {
      expect(hostToolNameOf(`mcp__user-input__${name}`)).toBe(name)
    }
  })

  it('is null for every other tool', () => {
    expect(hostToolNameOf('mcp__user-input__request_secret')).toBeNull()
    expect(hostToolNameOf('mcp__user-input__deliver_file')).toBeNull()
    expect(hostToolNameOf('schedule_task')).toBeNull()
    expect(hostToolNameOf('mcp__other__schedule_task')).toBeNull()
    expect(hostToolNameOf('Bash')).toBeNull()
  })
})
