import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { llmConnections } from '../db/schema'
import { calculateCost } from '../services/usage-service'
import { deleteConnection, getConnection, resolveExecutionSelection, saveConnection, setGlobalSelection } from './connections'
import { syncAllOllamaCatalogs, syncCatalogsFromStatus } from './ollama-catalog-sync'
import { ollamaModelDefinition } from './ollama-catalog'
import type { OllamaInstalledModel } from './ollama-schema'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('../db', () => ({ get db() { return state.db } }))

const viewer = { userId: null, admin: true }
const BASE = 'http://localhost:11434'
const model = (id: string): OllamaInstalledModel => ({ id, label: id, supportsThinking: true, supportsImageInput: false })

const save = (ollamaBaseUrl?: string) => saveConnection({
  name: 'Local', provider: 'ollama', userId: null,
  config: { apiKeys: ollamaBaseUrl ? { ollamaBaseUrl } : {} },
}, viewer)

const overridesOf = async (id: string) => JSON.parse((await getConnection(id))!.modelOverrides) as { id: string; disabled?: boolean }[]
const idsOf = async (id: string) => (await overridesOf(id)).map(entry => entry.id)

/** A server that has `models` installed. */
function serveTags(models: string[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: models.map(name => ({ model: name, capabilities: ['completion', 'tools'] })) }))
    if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }))
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

let handle: TestDatabase
beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await handle.close()
})

describe('Ollama catalog sync', () => {
  it('saves a normalized address and refuses one containers could not use', async () => {
    const id = await save('localhost:12345/')
    expect(JSON.parse((await getConnection(id))!.config).apiKeys.ollamaBaseUrl).toBe('http://localhost:12345')
    await expect(save('http://my-mac:11434')).rejects.toThrow('my-mac')
  })

  it('brings installed models in, and they resolve like any other model', async () => {
    const id = await save()
    await syncCatalogsFromStatus(BASE, [model('a:latest'), model('b:latest')])
    expect(await idsOf(id)).toEqual(['a:latest', 'b:latest'])
    await setGlobalSelection('default', { llmProviderId: id, model: 'b:latest' })
    expect(await resolveExecutionSelection(null)).toMatchObject({ wireModel: 'b:latest', llmProviderId: id })
  })

  it('only touches connections on the server that reported', async () => {
    const here = await save()
    const there = await save('http://192.168.1.20:11434')
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    expect(await idsOf(here)).toEqual(['a:latest'])
    expect(await idsOf(there)).toEqual([])
  })

  it('removes an uninstalled model, but keeps a switched-off one off even while it is gone', async () => {
    const id = await save()
    await syncCatalogsFromStatus(BASE, [model('a:latest'), model('b:latest')])
    await handle.db.update(llmConnections)
      .set({ modelOverrides: JSON.stringify([{ ...ollamaModelDefinition(model('a:latest')), disabled: true }, ollamaModelDefinition(model('b:latest'))]) })
      .where(eq(llmConnections.id, id)).run()
    await syncCatalogsFromStatus(BASE, [])
    expect(await overridesOf(id)).toMatchObject([{ id: 'a:latest', disabled: true }])
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    expect(await overridesOf(id)).toMatchObject([{ id: 'a:latest', disabled: true }])
  })

  it('keeps the connection\'s browser model listed after an uninstall', async () => {
    const id = await save()
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    await handle.db.update(llmConnections).set({ browserModel: 'a:latest' }).where(eq(llmConnections.id, id)).run()
    await syncCatalogsFromStatus(BASE, [])
    expect(await idsOf(id)).toEqual(['a:latest'])
  })

  it('keeps the app default listed after an uninstall, so saving the connection still works', async () => {
    const id = await save()
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    await setGlobalSelection('default', { llmProviderId: id, model: 'a:latest' })
    await syncCatalogsFromStatus(BASE, [model('b:latest')])
    expect(await idsOf(id)).toEqual(['a:latest', 'b:latest'])
    await expect(saveConnection({ name: 'Renamed', provider: 'ollama', userId: null, config: { apiKeys: {} } }, viewer, id)).resolves.toBe(id)
    expect((await deleteConnection(id, viewer).catch((error: Error) => error.message))).toContain('app default')
  })

  it('leaves the catalog alone when the server does not answer', async () => {
    const id = await save()
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await syncAllOllamaCatalogs()
    expect(await idsOf(id)).toEqual(['a:latest'])
  })

  it('asks each server once, however many connections are on it', async () => {
    const first = await save()
    const second = await save()
    const fetchMock = serveTags(['pulled-in-a-terminal:latest'])
    await syncAllOllamaCatalogs()
    expect(await idsOf(first)).toEqual(['pulled-in-a-terminal:latest'])
    expect(await idsOf(second)).toEqual(['pulled-in-a-terminal:latest'])
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/tags'))).toHaveLength(1)
  })

  it('does not bump the generation: a running session has no reason to restart', async () => {
    const id = await save()
    const before = (await getConnection(id))!.generation
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    expect((await getConnection(id))!.generation).toBe(before)
  })

  it('writes nothing when nothing changed', async () => {
    const id = await save()
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    const updatedAt = (await getConnection(id))!.updatedAt
    await new Promise(resolve => setTimeout(resolve, 5))
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    expect((await getConnection(id))!.updatedAt).toEqual(updatedAt)
  })

  it('ignores a connection of another provider', async () => {
    await saveConnection({ name: 'Key', provider: 'anthropic', userId: null, config: { apiKeys: { anthropicApiKey: 'k' } } }, viewer)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await syncAllOllamaCatalogs()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('costs nothing in the app\'s own usage numbers', async () => {
    await expect(calculateCost('qwen3.8:latest', 13006, 94, 0, 6011)).resolves.toBe(0)
  })
})
