import { describe, it, expect, vi, afterEach } from 'vitest'
import { captureException, captureMessage } from '@shared/lib/error-reporting'
import { prepareVolumeStop } from './volume-stop'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('volume stop telemetry and deadline', () => {
  it.each([200, 404])('continues without reporting for drained or legacy containers (%s)', async status => {
    const client = { fetch: vi.fn().mockResolvedValue(Response.json({ drained: true, recovered: 0, recoveryErrors: 0 }, { status })) }
    await prepareVolumeStop(client, 'test-agent')
    expect(captureMessage).not.toHaveBeenCalled()
    expect(captureException).not.toHaveBeenCalled()
  })

  it('reports preserved uploads to Sentry without names or file contents', async () => {
    await expect(prepareVolumeStop({ fetch: vi.fn().mockResolvedValue(Response.json({ drained: false, recovered: 2, recoveryErrors: 0 })) }, 'test-agent')).resolves.toBeUndefined()
    expect(captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      level: 'warning', extra: { agentId: 'test-agent', drained: false, recovered: 2, recoveryErrors: 0 },
    }))
  })

  it.each(['fetch', 'body'])('bounds a hung %s and continues shutdown', async phase => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('timeout')), ms)
      return controller.signal
    })
    const never = new Promise<never>(() => {})
    const client = { fetch: vi.fn().mockImplementation(() => phase === 'fetch' ? never : Promise.resolve({ ok: true, status: 200, json: () => never })) }
    const done = prepareVolumeStop(client, 'test-agent')
    await vi.advanceTimersByTimeAsync(20_000)
    await done
    expect(captureException).toHaveBeenCalledOnce()
  }, 25_000)

  it('reports an unreachable API and continues immediately', async () => {
    await expect(prepareVolumeStop({ fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }, 'test-agent')).resolves.toBeUndefined()
    expect(captureException).toHaveBeenCalledOnce()
  })
})
