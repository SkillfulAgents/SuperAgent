import { afterEach, describe, expect, it, vi } from 'vitest'

const sweep = vi.hoisted(() => ({
  cleanupStaleTempUploads: vi.fn(async () => undefined),
  startStaleUploadCleanup: vi.fn(),
}))
vi.mock('@shared/lib/utils/chunked-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/utils/chunked-upload')>()),
  ...sweep,
}))

afterEach(() => {
  vi.useRealTimers()
})

describe('the stale-upload sweep', () => {
  // A timer started on import fires in the middle of whatever a process that
  // loads the routes is doing, as the perf harness's measurements showed.
  it('does not start from importing the routes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })

    await import('./agents')
    await vi.advanceTimersByTimeAsync(31 * 60_000)

    expect(sweep.startStaleUploadCleanup).not.toHaveBeenCalled()
    expect(sweep.cleanupStaleTempUploads).not.toHaveBeenCalled()
  })
})
