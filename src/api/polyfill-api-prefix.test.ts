import { describe, expect, it } from 'vitest'

import { API_PREFIX_SNIPPET } from './polyfill-api-prefix'
import { getLlmPolyfillJs } from './llm-polyfill'
import { getPolyfillJs } from './speech-recognition-polyfill'

/** Run the injected snippet against a document URL and return what it resolved. */
function apiPrefixFor(documentHref: string): string {
  const url = new URL(documentHref)
  const evaluate = new Function('window', `${API_PREFIX_SNIPPET}; return apiPrefix;`)
  return evaluate({ location: { origin: url.origin, pathname: url.pathname } }) as string
}

describe('dashboard shim API prefix', () => {
  it('is empty when the dashboard is served directly, leaving URLs unchanged', () => {
    expect(apiPrefixFor('http://localhost:3000/api/agents/a1/artifacts/board/index.html')).toBe('')
  })

  it('keeps the cloud prefix when the dashboard is served through the proxy', () => {
    // Without this, the shims call the laptop's own API from a cloud dashboard —
    // local credentials, local settings, no visible failure.
    expect(
      apiPrefixFor('http://127.0.0.1:3000/cloud/KEY123/api/agents/a1/artifacts/board/index.html'),
    ).toBe('/cloud/KEY123')
  })

  it('takes the first marker, so a dashboard route of its own cannot shorten it', () => {
    expect(
      apiPrefixFor('http://127.0.0.1:3000/cloud/KEY123/api/agents/a1/artifacts/b/api/agents/x'),
    ).toBe('/cloud/KEY123')
  })

  it('falls back to no prefix if injected somewhere with no marker at all', () => {
    expect(apiPrefixFor('http://localhost:3000/elsewhere/index.html')).toBe('')
  })
})

describe('dashboard shims', () => {
  const shims = [
    ['speech recognition', getPolyfillJs()],
    ['llm', getLlmPolyfillJs()],
  ] as const

  it.each(shims)('%s shim resolves its API prefix from the document', (_name, source) => {
    expect(source).toContain('var apiPrefix =')
  })

  it.each(shims)('%s shim hardcodes no root-relative API path', (_name, source) => {
    // The regression this guards: a root-relative literal resolves against the
    // document's origin, which is the proxy's, not the deployment's. Every API
    // path in a shim must therefore be joined to apiPrefix — the one exception
    // being the marker apiPrefix is itself derived from.
    const unresolved = source
      .replace(/apiPrefix \+ "\/api\/[^"]*"/g, '')
      .replace(/var marker = "\/api\/agents\/";/, '')
    expect(unresolved).not.toMatch(/["']\/api\//)
  })

  it('llm shim points both the SDK load and the client at that prefix', () => {
    const source = getLlmPolyfillJs()
    expect(source).toContain('apiPrefix + "/api/llm/anthropic-sdk.js"')
    // The SDK needs an absolute baseURL, so this one keeps the origin it always
    // had and only gains the prefix.
    expect(source).toContain('baseURL: window.location.origin + apiPrefix + "/api/llm"')
  })

  it('speech recognition shim points its token call at that prefix', () => {
    expect(getPolyfillJs()).toContain('fetch(apiPrefix + "/api/stt/token")')
  })
})
