import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { llmConnections } from '../db/schema'
import { calculateCost } from '../services/usage-service'
import { deleteConnection, getConnection, resolveExecutionSelection, saveConnection, setGlobalSelection } from './connections'
import { syncAllOllamaCatalogs, syncCatalogsFromStatus } from './ollama-catalog-sync'
import { ollamaModelDefinition } from './ollama-catalog'
import type { InstalledModel } from './server-status-schema'
import { backgroundSettled } from '../background'
import { taskManager } from '../background-work'
import type { LocalTaskManager } from '../background-work/local-task-manager'
import { OLLAMA_CATALOG_SYNC_TASK } from './ollama-pull'
import { OLLAMA_CATALOG_SYNC_INTERVAL_MS, OllamaCatalogService } from './ollama-service'
import { globalFeed } from '../notifications/global-feed'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('../db', () => ({ get db() { return state.db } }))

const viewer = { userId: null, admin: true }
const BASE = 'http://localhost:11434'
const model = (id: string): InstalledModel => ({ id, label: id, supportsThinking: true, supportsImageInput: false })

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

  it('announces a catalog it changed, and not a pass that changed nothing', async () => {
    await save()
    const publish = vi.spyOn(globalFeed, 'publish')
    const announced = () => publish.mock.calls.filter(([event]) => event.type === 'llm_connections_changed').map(([event]) => event)
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    expect(announced()).toEqual([{ type: 'llm_connections_changed' }])
    await syncCatalogsFromStatus(BASE, [model('a:latest')])
    expect(announced()).toHaveLength(1)
    await syncCatalogsFromStatus(BASE, [model('a:latest'), model('b:latest')])
    expect(announced()).toHaveLength(2)
    publish.mockRestore()
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

const STATEMENT_METHODS = new Set(['select', 'selectDistinct', 'insert', 'update', 'delete', 'get', 'all', 'run'])

/** How many statements `work` starts on the database, the settings read among them. */
async function statementsDuring(work: () => Promise<unknown>): Promise<number> {
  const real = state.db!
  let count = 0
  state.db = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (STATEMENT_METHODS.has(String(prop))) count += 1
        return (value as (...args: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  try {
    await work()
  } finally {
    state.db = real
  }
  return count
}

describe('what a pass reads', () => {
  it('is one statement and no request when there is no Ollama connection', async () => {
    await saveConnection({ name: 'Key', provider: 'anthropic', userId: null, config: { apiKeys: { anthropicApiKey: 'k' } } }, viewer)
    const fetchMock = serveTags(['a:latest'])
    let connections: number | undefined
    expect(await statementsDuring(async () => { connections = await syncAllOllamaCatalogs() })).toBe(1)
    expect(connections).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is one statement when no server answers', async () => {
    await save()
    await save('http://192.168.1.20:11434')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect(await statementsDuring(syncAllOllamaCatalogs)).toBe(1)
  })

  it('is the same for one connection as for several, on one server or on many', async () => {
    serveTags(['a:latest'])
    await save()
    await syncAllOllamaCatalogs()
    const one = await statementsDuring(syncAllOllamaCatalogs)

    const more = [await save(), await save('http://192.168.1.20:11434'), await save('http://192.168.1.21:11434')]
    expect(await syncAllOllamaCatalogs()).toBe(4)
    for (const id of more) expect(await idsOf(id)).toEqual(['a:latest'])
    const several = await statementsDuring(syncAllOllamaCatalogs)

    // The connections to find the servers, then the rows and the settings to
    // write from. Nothing changed on these passes, so nothing is written.
    expect(one).toBe(3)
    expect(several).toBe(3)
  })

  it('reads the settings once per pass, however many connections it writes', async () => {
    const records = await import('../app-records/records')
    const { SETTINGS_RECORD_KEY } = await import('../app-records/record-schemas')
    const ids = [await save(), await save(), await save('http://192.168.1.20:11434')]
    serveTags(['a:latest'])
    const reads = vi.spyOn(records, 'readStoredRecord')
    // One write per connection here, on top of the three reads.
    expect(await statementsDuring(syncAllOllamaCatalogs)).toBe(3 + ids.length)
    expect(reads.mock.calls.filter(([key]) => key === SETTINGS_RECORD_KEY)).toHaveLength(1)
    reads.mockRestore()
    for (const id of ids) expect(await idsOf(id)).toEqual(['a:latest'])
  })
})

describe('saving an Ollama connection', () => {
  const scheduled = () => (taskManager() as LocalTaskManager).scheduled()
  const registerService = () => {
    for (const task of new OllamaCatalogService().tasks) taskManager().register(task)
  }

  it('asks for a pass, which lists the server\'s models and keeps the passes going', async () => {
    registerService()
    serveTags(['a:latest'])
    expect(scheduled()).toEqual([])
    const id = await save()
    await vi.waitFor(async () => expect(await idsOf(id)).toEqual(['a:latest']))
    await vi.waitFor(() => expect(scheduled()).toMatchObject([{ id: OLLAMA_CATALOG_SYNC_TASK, running: false }]))
    expect(scheduled()[0].nextRunAt).toBeGreaterThan(Date.now() + OLLAMA_CATALOG_SYNC_INTERVAL_MS - 5_000)
    await taskManager().cancel(OLLAMA_CATALOG_SYNC_TASK)
  })

  it('of another provider asks for nothing', async () => {
    registerService()
    await saveConnection({ name: 'Key', provider: 'anthropic', userId: null, config: { apiKeys: { anthropicApiKey: 'k' } } }, viewer)
    await backgroundSettled()
    expect(scheduled()).toEqual([])
  })
})
