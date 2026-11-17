import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ existing: new Set<string>() }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  accessSync: (candidate: string) => {
    if (!fs.existing.has(candidate)) throw new Error('ENOENT')
  },
}))

import { getOllamaStatus, isOlderOllamaVersion } from './ollama-client'

const BASE = 'http://localhost:11434'
type Answer = { status?: number; json?: unknown; throws?: Error }

function serve(routes: Record<string, Answer>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace(BASE, '').replace('http://box.example.com:11434', '')
    calls.push(path)
    const answer = routes[path] ?? { status: 404 }
    if (answer.throws) throw answer.throws
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200 })
  }))
  return calls
}

const tags = (...models: unknown[]) => ({ json: { models } })

beforeEach(() => {
  fs.existing.clear()
  vi.stubEnv('PATH', '/nonexistent')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('getOllamaStatus', () => {
  it('reports a running server and what each model can do', async () => {
    serve({
      '/api/version': { json: { version: '0.40.15' } },
      '/api/tags': tags(
        { model: 'qwen3.8:latest', size: 18_000_000_000, digest: 'a', capabilities: ['completion', 'tools', 'thinking', 'vision'] },
        { model: 'old:7b', digest: 'b', capabilities: ['completion'] },
        { model: 'embed:latest', digest: 'c', capabilities: ['embedding'] },
      ),
      '/api/ps': { json: { models: [] } },
      '/api/show': { json: { model_info: { 'qwen3_5.context_length': 262144 } } },
    })
    const status = await getOllamaStatus(BASE)
    expect(status).toMatchObject({ state: 'running', version: '0.40.15', upgradeRequired: false })
    if (status.state !== 'running') throw new Error('unreachable')
    expect(status.models.map(m => [m.id, m.label, m.unusableReason])).toEqual([
      ['qwen3.8:latest', 'qwen3.8', undefined],
      ['old:7b', 'old:7b', 'no-tools'],
      ['embed:latest', 'embed', 'embedding-only'],
    ])
    expect(status.models[0]).toMatchObject({ supportsThinking: true, supportsImageInput: true, contextWindow: 262144, sizeBytes: 18_000_000_000 })
  })

  it('falls back to /api/show on a server whose listing has no capabilities', async () => {
    serve({
      '/api/version': { json: { version: '0.20.0' } },
      '/api/tags': tags({ model: 'm:latest', digest: 'old-listing' }),
      '/api/show': { json: { capabilities: ['completion'] } },
    })
    const status = await getOllamaStatus(BASE)
    expect(status.state === 'running' && status.models[0].unusableReason).toBe('no-tools')
  })

  it('asks /api/show about a digest once', async () => {
    const calls = serve({
      '/api/version': { json: {} },
      '/api/tags': tags({ model: 'm:latest', digest: 'cached-digest', capabilities: ['completion', 'tools'] }),
      '/api/show': { json: { model_info: { 'x.context_length': 1000 } } },
    })
    await getOllamaStatus(BASE)
    await getOllamaStatus(BASE)
    expect(calls.filter(path => path === '/api/show')).toHaveLength(1)
  })

  it('prefers the context a loaded model actually got, and warns when agents would not fit', async () => {
    serve({
      '/api/version': { json: {} },
      '/api/tags': tags({ model: 'm:latest', digest: 'small', capabilities: ['completion', 'tools'] }),
      '/api/show': { json: { model_info: { 'x.context_length': 262144 } } },
      '/api/ps': { json: { models: [{ model: 'm:latest', context_length: 4096 }] } },
    })
    const status = await getOllamaStatus(BASE)
    expect(status).toMatchObject({ smallContext: { model: 'm:latest', tokens: 4096 } })
    expect(status.state === 'running' && status.models[0].contextWindow).toBe(4096)
  })

  it('flags a server too old for the Messages API', async () => {
    serve({ '/api/version': { json: { version: '0.13.5' } }, '/api/tags': tags() })
    expect(await getOllamaStatus(BASE)).toMatchObject({ state: 'running', upgradeRequired: true })
  })

  it('says not-found when nothing answers and no install is on this machine', async () => {
    serve({ '/api/version': { throws: new TypeError('fetch failed') } })
    expect(await getOllamaStatus(BASE)).toMatchObject({ state: 'not-found', error: `Could not connect to ${BASE}` })
  })

  it('says stopped when nothing answers but an install is on PATH', async () => {
    vi.stubEnv('PATH', '/custom/bin')
    fs.existing.add('/custom/bin/ollama')
    serve({ '/api/version': { throws: new TypeError('fetch failed') } })
    expect(await getOllamaStatus(BASE)).toMatchObject({ state: 'stopped' })
  })

  it('says unreachable for another machine, without claiming what is installed there', async () => {
    fs.existing.add('/usr/local/bin/ollama')
    serve({ '/api/version': { throws: new TypeError('fetch failed') } })
    expect(await getOllamaStatus('http://box.example.com:11434')).toMatchObject({ state: 'unreachable' })
  })

  it('tells a server that answers from one that is Ollama', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>hello</html>')))
    expect((await getOllamaStatus(BASE) as { error: string }).error).toContain('not like an Ollama server')
  })
})

describe('isOlderOllamaVersion', () => {
  it.each([
    ['0.13.9', true],
    ['0.14.0', false],
    ['v0.14.0-rc1', false],
    ['0.40.15', false],
    ['1.0.0', false],
  ])('%s -> %s', (version, older) => {
    expect(isOlderOllamaVersion(version)).toBe(older)
  })
})
