// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Facts, ServerFacts } from '@shared/lib/facts/facts-schema'
import { withServerFacts } from '@shared/lib/facts/server-facts'
import { _resetFactsForTest, clientFacts, initFacts, serverFacts } from './facts'

/**
 * How a renderer comes to know the facts with no request of its own: from its
 * HTML on the web, from main in Electron.
 */

const DEPLOYMENT: ServerFacts = { os: 'linux', distribution: 'deployment' }

/** Load a page whose head is what the web server would have served. */
function loadHtml(html: string) {
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML
}

beforeEach(() => {
  _resetFactsForTest()
  document.documentElement.innerHTML = '<head></head><body></body>'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.electronAPI
})

describe('on the web', () => {
  it('reads the facts the server inlined into its HTML', async () => {
    loadHtml(withServerFacts('<html><head><title>App</title></head><body></body></html>', DEPLOYMENT))
    await initFacts('local')

    expect(serverFacts()).toEqual(DEPLOYMENT)
    expect(clientFacts()).toEqual({ shell: 'browser', os: null, distribution: null })
  })

  it('has no server facts from HTML precached before there were any', async () => {
    loadHtml('<html><head><title>App</title></head><body></body></html>')
    await initFacts('local')

    expect(serverFacts()).toBeNull()
  })

  it.each([
    ['not JSON', '{os: linux'],
    ['a value it does not know', JSON.stringify({ os: 'linux', distribution: 'something-new' })],
  ])('has no server facts when the block is %s', async (_, text) => {
    loadHtml(`<html><head><script type="application/json" id="server-facts">${text}</script></head><body></body></html>`)
    await initFacts('local')

    expect(serverFacts()).toBeNull()
  })

  it('keeps the facts it knows when a newer server sends more', async () => {
    loadHtml(withServerFacts('<html><head></head><body></body></html>', { ...DEPLOYMENT, newFact: true } as ServerFacts))
    await initFacts('local')

    expect(serverFacts()).toEqual(DEPLOYMENT)
  })
})

describe('in Electron', () => {
  const fromMain: Facts = {
    client: { shell: 'electron', os: 'darwin', distribution: 'mac-app-store' },
    server: DEPLOYMENT,
  }

  function stubElectron(api: Partial<NonNullable<Window['electronAPI']>>) {
    window.electronAPI = { platform: 'darwin', ...api } as NonNullable<Window['electronAPI']>
  }

  it('takes main’s answer for the target it settled', async () => {
    const getFacts = vi.fn(async () => fromMain)
    stubElectron({ getFacts })
    await initFacts('cloud')

    expect(getFacts).toHaveBeenCalledWith('cloud')
    expect(clientFacts()).toEqual(fromMain.client)
    expect(serverFacts()).toEqual(fromMain.server)
  })

  it('ignores a facts block in its HTML, which can only describe the dev server', async () => {
    loadHtml(withServerFacts('<html><head></head><body></body></html>', { os: 'darwin', distribution: 'direct' }))
    stubElectron({ getFacts: async () => fromMain })
    await initFacts('cloud')

    expect(serverFacts()).toEqual(DEPLOYMENT)
  })

  it.each([
    ['is too old to have the handler', {}],
    ['fails to answer', { getFacts: async () => Promise.reject(new Error('ipc down')) }],
  ])('knows only the window when main %s', async (_, api) => {
    stubElectron(api)
    await initFacts('local')

    expect(clientFacts()).toEqual({ shell: 'electron', os: 'darwin', distribution: null })
    expect(serverFacts()).toBeNull()
  })
})

it('throws if read before boot settles the facts', () => {
  expect(() => clientFacts()).toThrow('Facts read before initApiBaseUrl() settled them')
  expect(() => serverFacts()).toThrow('Facts read before initApiBaseUrl() settled them')
})
