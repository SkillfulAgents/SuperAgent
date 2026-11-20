import { afterEach, expect, it, vi } from 'vitest'
import { runtimeCapabilities } from '@shared/lib/facts/capabilities'
import { declareServerCapabilities } from '@shared/lib/facts/server-facts'

vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: {}, containerHost: {} }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const fs = { ...actual, existsSync: () => true }
  return { ...fs, default: fs }
})

import { ChromeProvider } from './chrome-provider'

afterEach(() => {
  vi.unstubAllEnvs()
  declareServerCapabilities(null)
})

it('offers the installed Chrome in the desktop app outside the sandbox', async () => {
  declareServerCapabilities(runtimeCapabilities({ os: 'darwin', distribution: 'direct' }))
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

it('is unavailable on a web deployment, whose machine is not the person’s, and says so without naming the Store', async () => {
  // A test process is a deployment.
  expect(await new ChromeProvider().detect()).toEqual({
    id: 'chrome',
    name: 'Google Chrome',
    available: false,
    reason: 'Not available on this server',
  })
})
