import { describe, expect, it, vi } from 'vitest'
import { backgroundSettled } from '@shared/lib/background'
import type { ErrorReportingProvider } from '@shared/lib/error-reporting'
import { createCloudflareErrorReporter, type CloudflareErrorReporterOptions } from './cloudflare-error-reporting'

const INGEST = 'https://publickey@o1.ingest.example.com/42'

function reporter(overrides: Partial<CloudflareErrorReporterOptions> = {}) {
  const sent: Array<{ url: string; init: RequestInit }> = []
  const provider: ErrorReportingProvider = createCloudflareErrorReporter({
    environment: 'cloudflare',
    ingestUrl: INGEST,
    send: async (url, init) => {
      sent.push({ url, init })
      return new Response(null, { status: 200 })
    },
    allowed: async () => true,
    identify: async () => provider.setTenantId('tenant-7'),
    ...overrides,
  })!
  /** The event of each envelope sent: the third line. */
  const events = () => sent.map(({ init }) => JSON.parse(String(init.body).split('\n')[2]) as Record<string, any>)
  return { provider, sent, events }
}

describe('Cloudflare error reporter', () => {
  it('sends an error to the ingest endpoint with its cause, tenant and tags', async () => {
    const { provider, sent, events } = reporter()
    provider.setTag('runtime', 'worker')

    const id = provider.captureException(new Error('The workspace save failed', { cause: new TypeError('fetch failed') }), {
      tags: { component: 'agent-object' },
      extra: { agent: 'sales-agent' },
    })
    await backgroundSettled()

    expect(sent[0].url).toBe('https://o1.ingest.example.com/api/42/envelope/')
    expect((sent[0].init.headers as Record<string, string>)['x-sentry-auth']).toContain('sentry_key=publickey')
    const [event] = events()
    expect(event.event_id).toBe(id)
    expect(event.level).toBe('error')
    expect(event.environment).toBe('cloudflare')
    expect(event.user).toEqual({ id: 'tenant-7' })
    expect(event.tags).toEqual({ runtime: 'worker', component: 'agent-object' })
    expect(event.extra).toEqual({ agent: 'sales-agent' })
    // The cause first, then the error that was reported.
    expect(event.exception.values.map((value: { type: string; value: string }) => [value.type, value.value])).toEqual([
      ['TypeError', 'fetch failed'],
      ['Error', 'The workspace save failed'],
    ])
    expect(event.exception.values[1].stacktrace.frames.length).toBeGreaterThan(0)
  })

  it('sends nothing when the org turned error reports off', async () => {
    const { provider, sent } = reporter({ allowed: async () => false })

    provider.captureException(new Error('The workspace save failed'))
    await backgroundSettled()

    expect(sent).toEqual([])
  })

  it('never fails the caller when a report cannot be sent', async () => {
    const send = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const { provider } = reporter({ send })

    expect(() => provider.captureMessage('The deploy step did not run', { level: 'error', extra: { cycle: cyclic() } })).not.toThrow()
    await backgroundSettled()

    expect(send).toHaveBeenCalledTimes(1)
    expect(await provider.flush(10)).toBe(true)
  })

  it('keeps no user between calls, so one request never reports as another user', async () => {
    const { provider, events } = reporter()

    provider.setUser({ id: 'user-1', email: 'dana@example.com' })
    provider.captureMessage('The deploy step did not run')
    await backgroundSettled()

    expect(events()[0].user).toEqual({ id: 'tenant-7' })
  })
})

function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = {}
  value.self = value
  return value
}
