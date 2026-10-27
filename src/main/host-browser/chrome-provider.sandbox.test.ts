import { afterEach, expect, it, vi } from 'vitest'

const listChromeProfiles = vi.hoisted(() => vi.fn(() => [{ id: 'Default', name: 'Person 1' }]))
vi.mock('@shared/lib/browser/chrome-profile', () => ({ listChromeProfiles }))
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

it('offers the installed Chrome and its profiles outside the sandbox', () => {
  expect(new ChromeProvider().detect()).toMatchObject({ available: true, profiles: [{ id: 'Default' }] })
})

it('is unavailable in the Mac App Store edition, and says so, without reading Chrome’s profiles', () => {
  vi.stubEnv('E2E_MOCK', 'true')
  vi.stubEnv('SUPERAGENT_FAKE_DISTRIBUTION', 'mac-app-store')
  listChromeProfiles.mockClear()

  expect(new ChromeProvider().detect()).toEqual({
    id: 'chrome',
    name: 'Google Chrome',
    available: false,
    reason: 'Not available in the Mac App Store edition',
  })
  expect(listChromeProfiles).not.toHaveBeenCalled()
})
