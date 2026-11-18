import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: {}, containerHost: {} }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const fs = { ...actual, existsSync: () => true }
  return { ...fs, default: fs }
})

import { ChromeProvider } from './chrome-provider'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('offers the installed Chrome outside the sandbox', async () => {
  expect(await new ChromeProvider().detect()).toEqual({ id: 'chrome', name: 'Google Chrome', available: true })
})

it('is unavailable in the Mac App Store edition, and says so', async () => {
  vi.stubEnv('E2E_MOCK', 'true')
  vi.stubEnv('SUPERAGENT_FAKE_DISTRIBUTION', 'mac-app-store')

  expect(await new ChromeProvider().detect()).toEqual({
    id: 'chrome',
    name: 'Google Chrome',
    available: false,
    reason: 'Not available in the Mac App Store edition',
  })
})
