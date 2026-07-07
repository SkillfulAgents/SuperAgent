import { describe, it, expect, beforeEach, vi } from 'vitest'

const getClient = vi.fn()
const getCachedInfo = vi.fn()
vi.mock('./container-manager', () => ({
  containerManager: {
    getClient: (...args: unknown[]) => getClient(...args),
    getCachedInfo: (...args: unknown[]) => getCachedInfo(...args),
  },
}))

const markSessionInterrupted = vi.fn()
vi.mock('./message-persister', () => ({
  messagePersister: {
    markSessionInterrupted: (...args: unknown[]) => markSessionInterrupted(...args),
  },
}))

const denyAllForAgent = vi.fn()
vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    denyAllForAgent: (...args: unknown[]) => denyAllForAgent(...args),
  },
}))

import { interruptAgentSession } from './interrupt-session'

describe('interruptAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markSessionInterrupted.mockResolvedValue(undefined)
  })

  it('interrupts in the container and settles locally when running', async () => {
    const interruptSession = vi.fn().mockResolvedValue(true)
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'running' })

    const outcome = await interruptAgentSession('agent-1', 'session-1')

    expect(interruptSession).toHaveBeenCalledWith('session-1')
    expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
    expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
    expect(outcome).toBe('interrupted')
  })

  it('settles locally without a container call when the container is not running', async () => {
    const interruptSession = vi.fn()
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'stopped' })

    const outcome = await interruptAgentSession('agent-1', 'session-1')

    expect(interruptSession).not.toHaveBeenCalled()
    expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
    expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
    expect(outcome).toBe('container-not-running')
  })

  it('still settles locally when interruptSession returns false', async () => {
    const interruptSession = vi.fn().mockResolvedValue(false)
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'running' })

    const outcome = await interruptAgentSession('agent-1', 'session-1')

    expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
    expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
    expect(outcome).toBe('interrupted')
  })

  it('still settles locally when the container interrupt throws', async () => {
    const interruptSession = vi.fn().mockRejectedValue(new Error('wedged'))
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'running' })

    const outcome = await interruptAgentSession('agent-1', 'session-1')

    expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
    expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
    expect(outcome).toBe('error-settled-locally')
  })
})
