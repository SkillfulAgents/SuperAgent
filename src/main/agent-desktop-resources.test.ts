import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

interface Resource { from: string; to: string }
const { build } = require('../../package.json') as {
  build: { mac: { extraResources: Resource[] }; win: { extraResources?: Resource[] } }
}

/** The extra resources a platform's build copies out of the agent-desktop npm package. */
const fromAgentDesktop = (resources: Resource[] = []) => resources.filter((resource) => resource.from.startsWith('node_modules/agent-desktop/'))

// electron-builder only warns when an extra resource's source is missing, and
// the app excludes the npm package's own copies: a binary renamed upstream
// would ship a build without computer use.
describe('agent-desktop in the desktop builds', () => {
  it.each([
    ['mac', build.mac.extraResources, ['agent-desktop/agent-desktop', 'agent-desktop/agent-desktop-macos-helper']],
    ['win', build.win.extraResources, ['agent-desktop/agent-desktop.exe']],
  ])('the %s build copies binaries the npm package has, for each architecture', (_platform, resources, destinations) => {
    const entries = fromAgentDesktop(resources)
    expect(entries.map((resource) => resource.to).sort()).toEqual([...destinations].sort())
    for (const arch of ['arm64', 'x64']) {
      for (const { from } of entries) {
        const source = from.replace(/\$\{arch\}/, arch)
        expect(existsSync(join(ROOT, source)), source).toBe(true)
      }
    }
  })
})
