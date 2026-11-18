import { afterAll, expect, it, vi } from 'vitest'

// The Lima layout an App Sandbox build fixes when this module loads.
vi.mock('@shared/lib/facts/server-facts', () => ({
  getServerFacts: () => ({ os: 'darwin', distribution: 'mac-app-store' }),
}))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, default: { ...actual, homedir: () => '/Users/testuser/Library/Containers/so.gamut.app/Data' } }
})

const envBefore = { home: process.env.SUPERAGENT_LIMA_HOME, vm: process.env.SUPERAGENT_LIMA_VM }

import { LIMA_VM_NAME, getLimaHome } from './lima-container-client'

afterAll(() => {
  for (const [key, value] of [['SUPERAGENT_LIMA_HOME', envBefore.home], ['SUPERAGENT_LIMA_VM', envBefore.vm]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it('uses a short Lima home and VM name, so every socket fits under the container’s long home', () => {
  const home = '/Users/testuser/Library/Containers/so.gamut.app/Data'
  expect(LIMA_VM_NAME).toBe('sa')
  expect(getLimaHome()).toBe(`${home}/l`)

  // OpenSSH's temporary ControlMaster socket is the longest Lima makes.
  const longest = `${getLimaHome()}/${LIMA_VM_NAME}/ssh.sock.${'x'.repeat(16)}`
  expect(longest.length).toBeLessThan(104)
})

it('points the bundled nerdctl wrapper at that VM', () => {
  expect(process.env.SUPERAGENT_LIMA_HOME).toBe(getLimaHome())
  expect(process.env.SUPERAGENT_LIMA_VM).toBe('sa')
})
