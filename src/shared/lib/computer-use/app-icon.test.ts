import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const mockExecFile = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

vi.mock('util', () => ({
  promisify: () => (...args: unknown[]) => {
    // Return a promise that calls the mock
    return mockExecFile(...args)
  },
}))

// We need to reset module state between tests because of the cache
let getAppIconBase64: (appName: string) => Promise<string | null>

async function loadModule() {
  // Force fresh import to reset module-level cache
  const mod = await import('./app-icon')
  getAppIconBase64 = mod.getAppIconBase64
}

describe('getAppIconBase64', () => {
  const ORIGINAL_PLATFORM = process.platform

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    // Default to darwin
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    await loadModule()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  })

  it('returns null on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const result = await getAppIconBase64('Calculator')
    expect(result).toBeNull()
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns base64 string for valid app', async () => {
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA'
    mockExecFile.mockResolvedValue({ stdout: fakeBase64 + '\n' })
    const result = await getAppIconBase64('Calculator')
    expect(result).toBe(fakeBase64)
  })

  it('returns null for empty output', async () => {
    mockExecFile.mockResolvedValue({ stdout: '' })
    const result = await getAppIconBase64('NonexistentApp')
    expect(result).toBeNull()
  })

  it('returns null for very short output', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'short' })
    const result = await getAppIconBase64('BrokenApp')
    expect(result).toBeNull()
  })

  it('returns null when osascript throws', async () => {
    mockExecFile.mockRejectedValue(new Error('osascript failed'))
    const result = await getAppIconBase64('BadApp')
    expect(result).toBeNull()
  })

  it('caches successful results', async () => {
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA'
    mockExecFile.mockResolvedValue({ stdout: fakeBase64 })
    await getAppIconBase64('Calculator')
    await getAppIconBase64('Calculator')
    // Only one call to osascript
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('caches null results with TTL', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    await getAppIconBase64('Missing')
    // Second call within TTL should hit cache
    await getAppIconBase64('Missing')
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('retries null results after TTL expires', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    mockExecFile.mockRejectedValue(new Error('not found'))
    await getAppIconBase64('Missing')
    expect(mockExecFile).toHaveBeenCalledTimes(1)

    // Fast-forward past TTL (5 minutes)
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000 + 1)
    mockExecFile.mockRejectedValue(new Error('not found'))
    await getAppIconBase64('Missing')
    // Should have retried
    expect(mockExecFile).toHaveBeenCalledTimes(2)
  })

  it('successful cache never expires', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA'
    mockExecFile.mockResolvedValue({ stdout: fakeBase64 })
    await getAppIconBase64('Calculator')

    // Fast-forward 1 hour
    vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000)
    const result = await getAppIconBase64('Calculator')
    expect(result).toBe(fakeBase64)
    // Still only one osascript call
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('uses JSON.stringify for app name escaping', async () => {
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA'
    mockExecFile.mockResolvedValue({ stdout: fakeBase64 })
    await getAppIconBase64('App "With Quotes"')
    // The function is called with ('osascript', [args...], { timeout: 5000 })
    const callArgs = mockExecFile.mock.calls[0]
    const allArgs = JSON.stringify(callArgs)
    // JSON.stringify('App "With Quotes"') produces "App \"With Quotes\""
    // In the double-serialized form, that's: App \\\"With Quotes\\\"
    expect(allArgs).toContain('App \\\\\\"With Quotes\\\\\\"')
  })
})
