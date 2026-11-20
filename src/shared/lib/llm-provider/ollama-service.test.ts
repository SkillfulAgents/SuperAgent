/**
 * The catalog sync passes only while there is an Ollama connection to keep
 * current. With none it schedules nothing, so an install that never set Ollama
 * up is not woken once a minute to read a table with no row for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { taskManager } from '../background-work'
import type { LocalTaskManager } from '../background-work/local-task-manager'

const sync = vi.hoisted(() => ({ pass: vi.fn(async (): Promise<number> => 0) }))
vi.mock('./ollama-catalog-sync', () => ({ syncAllOllamaCatalogs: sync.pass }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))

import { OLLAMA_CATALOG_SYNC_INTERVAL_MS, OllamaCatalogService } from './ollama-service'
import { OLLAMA_CATALOG_SYNC_TASK, requestOllamaCatalogSync } from './ollama-pull'

const scheduled = () => (taskManager() as LocalTaskManager).scheduled()
const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * OLLAMA_CATALOG_SYNC_INTERVAL_MS)

async function startService(): Promise<void> {
  const service = new OllamaCatalogService()
  for (const task of service.tasks) taskManager().register(task)
  await service.start()
}

beforeEach(() => {
  vi.useFakeTimers()
  sync.pass.mockReset()
  sync.pass.mockResolvedValue(0)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Ollama catalog service', () => {
  it('with no Ollama connection, looks once after start and schedules nothing more', async () => {
    await startService()
    expect(sync.pass).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync.pass).toHaveBeenCalledTimes(1)
    expect(scheduled()).toEqual([])
    await minutes(60)
    expect(sync.pass).toHaveBeenCalledTimes(1)
  })

  it('with a connection, passes once a minute', async () => {
    sync.pass.mockResolvedValue(2)
    await startService()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync.pass).toHaveBeenCalledTimes(1)
    expect(scheduled()).toMatchObject([{ id: OLLAMA_CATALOG_SYNC_TASK, recurring: false }])
    await minutes(3)
    expect(sync.pass).toHaveBeenCalledTimes(4)
  })

  it('stops once the last connection is gone', async () => {
    sync.pass.mockResolvedValue(1)
    await startService()
    await vi.advanceTimersByTimeAsync(5_000)
    await minutes(1)
    expect(sync.pass).toHaveBeenCalledTimes(2)
    sync.pass.mockResolvedValue(0)
    await minutes(1)
    expect(sync.pass).toHaveBeenCalledTimes(3)
    expect(scheduled()).toEqual([])
    await minutes(60)
    expect(sync.pass).toHaveBeenCalledTimes(3)
  })

  it('a request starts the passes again, at once', async () => {
    await startService()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(scheduled()).toEqual([])

    sync.pass.mockResolvedValue(1)
    await requestOllamaCatalogSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.pass).toHaveBeenCalledTimes(2)
    await minutes(2)
    expect(sync.pass).toHaveBeenCalledTimes(4)
  })

  it('a request while passes are going moves the next one up, and adds no second series', async () => {
    sync.pass.mockResolvedValue(1)
    await startService()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(20_000)
    await requestOllamaCatalogSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.pass).toHaveBeenCalledTimes(2)
    expect(scheduled()).toHaveLength(1)
    await minutes(3)
    expect(sync.pass).toHaveBeenCalledTimes(5)
  })

  it('keeps passing after a pass that threw: how many connections there are is not known', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    sync.pass.mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue(1)
    await startService()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync.pass).toHaveBeenCalledTimes(1)
    await minutes(1)
    expect(sync.pass).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('a request does nothing where the sync is not registered', async () => {
    await requestOllamaCatalogSync()
    expect(scheduled()).toEqual([])
  })
})
