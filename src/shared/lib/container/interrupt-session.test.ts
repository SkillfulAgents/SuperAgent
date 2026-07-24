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

import { interruptAgentSession, INTERRUPT_TIMEOUT_MS } from './interrupt-session'

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

  it('settles locally when the container interrupt HANGS (bounded by the timeout)', async () => {
    // The unbounded case is /stop's own pathology: a wedged container whose
    // HTTP call never returns must not block the chat's serial queue.
    vi.useFakeTimers()
    try {
      const interruptSession = vi.fn().mockReturnValue(new Promise(() => {}))
      getClient.mockReturnValue({ interruptSession })
      getCachedInfo.mockReturnValue({ status: 'running' })

      const pending = interruptAgentSession('agent-1', 'session-1')
      await vi.advanceTimersByTimeAsync(INTERRUPT_TIMEOUT_MS)
      const outcome = await pending

      expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
      expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
      expect(outcome).toBe('error-settled-locally')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rethrows on a double fault (interrupt AND local settling both throw), skipping denyAll', async () => {
    // Pins the contract the API route's 500 depends on: only when even the
    // catch-path markSessionInterrupted throws does the helper propagate.
    const interruptSession = vi.fn().mockRejectedValue(new Error('wedged'))
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'running' })
    markSessionInterrupted.mockRejectedValue(new Error('persister down'))

    await expect(interruptAgentSession('agent-1', 'session-1')).rejects.toThrow('persister down')
    expect(denyAllForAgent).not.toHaveBeenCalled()
  })
})
