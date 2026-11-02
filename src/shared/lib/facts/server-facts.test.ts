import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVER_FACTS_REVISION_PLACEHOLDER, serverFactsSchema, type ServerFacts } from './facts-schema'
import { currentOs, desktopDistribution, getServerFacts, withServerFacts, withServerFactsRevision } from './server-facts'

/** Pretend to be a given process, the way Electron sets these. */
function stubProcess(props: { platform?: string; type?: string; mas?: boolean; windowsStore?: boolean }) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(process, key, { value, configurable: true, writable: true })
  }
}

const original = {
  platform: Object.getOwnPropertyDescriptor(process, 'platform'),
  type: Object.getOwnPropertyDescriptor(process, 'type'),
  mas: Object.getOwnPropertyDescriptor(process, 'mas'),
  windowsStore: Object.getOwnPropertyDescriptor(process, 'windowsStore'),
}

afterEach(() => {
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(process, key, descriptor)
    else delete (process as unknown as Record<string, unknown>)[key]
  }
})

describe('currentOs', () => {
  it.each([
    ['darwin', 'darwin'],
    ['win32', 'win32'],
    ['linux', 'linux'],
    ['freebsd', 'other'],
  ])('reads %s as %s', (platform, os) => {
    stubProcess({ platform })
    expect(currentOs()).toBe(os)
  })
})

describe('desktopDistribution', () => {
  it('is null outside Electron main, where no desktop install hosts the API', () => {
    stubProcess({ type: undefined, mas: true })
    expect(desktopDistribution()).toBeNull()
  })

  it.each([
    [{ mas: true }, 'mac-app-store'],
    [{ windowsStore: true }, 'windows-store'],
    [{}, 'direct'],
  ] as const)('reads %o in Electron main as %s', (flags, distribution) => {
    stubProcess({ type: 'browser', mas: false, windowsStore: false, ...flags })
    expect(desktopDistribution()).toBe(distribution)
  })
})

describe('getServerFacts', () => {
  it('is a web deployment outside Electron', () => {
    stubProcess({ type: undefined, platform: 'linux' })
    expect(getServerFacts()).toEqual({ os: 'linux', distribution: 'deployment' })
  })

  it('is the desktop install when Electron main hosts the API', () => {
    stubProcess({ type: 'browser', platform: 'darwin', mas: true })
    expect(getServerFacts()).toEqual({ os: 'darwin', distribution: 'mac-app-store' })
  })

  describe('a faked distribution', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('is what a mock run asks for, so the web build can show a Store build’s server', () => {
      stubProcess({ type: undefined, platform: 'darwin' })
      vi.stubEnv('E2E_MOCK', 'true')
      vi.stubEnv('SUPERAGENT_FAKE_DISTRIBUTION', 'mac-app-store')
      expect(getServerFacts()).toEqual({ os: 'darwin', distribution: 'mac-app-store' })
    })

    it('is ignored outside a mock run, and when it names no distribution', () => {
      stubProcess({ type: undefined, platform: 'linux' })
      vi.stubEnv('SUPERAGENT_FAKE_DISTRIBUTION', 'mac-app-store')
      expect(getServerFacts().distribution).toBe('deployment')
      vi.stubEnv('E2E_MOCK', 'true')
      vi.stubEnv('SUPERAGENT_FAKE_DISTRIBUTION', 'app-store')
      expect(getServerFacts().distribution).toBe('deployment')
    })
  })
})

describe('withServerFacts', () => {
  const FACTS: ServerFacts = { os: 'linux', distribution: 'deployment' }

  function blockText(html: string): string {
    const match = html.match(/<script type="application\/json" id="server-facts">(.*?)<\/script>/s)
    if (!match) throw new Error('no facts block')
    return match[1]
  }

  it('inlines the facts at the end of the head, where the page reads them', () => {
    const html = withServerFacts('<html><head><title>App</title></head><body><div id="root"></div></body></html>', FACTS)

    expect(html).toMatch(/<title>App<\/title><script type="application\/json" id="server-facts">.*<\/script>\n<\/head>/)
    expect(serverFactsSchema.parse(JSON.parse(blockText(html)))).toEqual(FACTS)
  })

  it('escapes < so no value can close the block early', () => {
    const hostile = { os: '</script><script>alert(1)</script>', distribution: 'deployment' } as unknown as ServerFacts
    const html = withServerFacts('<html><head></head><body></body></html>', hostile)

    expect(html.match(/<script/g)).toHaveLength(1)
    expect(JSON.parse(blockText(html)).os).toBe(hostile.os)
  })

  it('refuses HTML with no head rather than serving a page without facts', () => {
    expect(() => withServerFacts('<!doctype html><title>App</title>', FACTS)).toThrow('no </head>')
  })
})

describe('withServerFactsRevision', () => {
  const FACTS: ServerFacts = { os: 'linux', distribution: 'deployment' }
  const SW = `precacheAndRoute([{url:"index.html",revision:"abc-${SERVER_FACTS_REVISION_PLACEHOLDER}"}])`

  function revision(sw: string): string {
    const match = sw.match(/revision:"([^"]*)"/)
    if (!match) throw new Error('no revision')
    return match[1]
  }

  // The worker refetches its precached HTML, and so its facts, only when this changes.
  it('gives the HTML entry a revision that changes with the facts, and only with them', () => {
    const linux = revision(withServerFactsRevision(SW, FACTS))
    expect(linux).toMatch(/^abc-[0-9a-f]{12}$/)
    expect(revision(withServerFactsRevision(SW, { ...FACTS }))).toBe(linux)
    expect(revision(withServerFactsRevision(SW, { ...FACTS, os: 'win32' }))).not.toBe(linux)
  })

  it('leaves a worker built without the placeholder as it is', () => {
    const sw = 'precacheAndRoute([{url:"index.html",revision:"abc"}])'
    expect(withServerFactsRevision(sw, FACTS)).toBe(sw)
  })
})
