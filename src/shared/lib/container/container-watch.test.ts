import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stopBackgroundWork, taskManager } from '@shared/lib/background-work'
import type { LocalTaskManager } from '@shared/lib/background-work/local-task-manager'
import { ContainerWatch } from './container-watch'

const HEALTH_MS = 30_000
const STATUS_MS = 300_000

function watchOf(slug: string) {
  const checkHealth = vi.fn(async () => {})
  const checkStatus = vi.fn(async () => {})
  return { watch: new ContainerWatch(slug, { checkHealth, checkStatus }), checkHealth, checkStatus }
}

const jobIds = () => (taskManager() as LocalTaskManager).scheduled().map((job) => job.id).sort()

describe('ContainerWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks the status every 300 s until it stops, and the health every 30 s only while the container runs', async () => {
    const { watch, checkHealth, checkStatus } = watchOf('agent-a')
    watch.start()
    expect(jobIds()).toEqual(['container-watch.status:agent-a'])

    watch.startHealth()
    expect(jobIds()).toEqual(['container-watch.health:agent-a', 'container-watch.status:agent-a'])
    await vi.advanceTimersByTimeAsync(HEALTH_MS - 1)
    expect(checkHealth).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(checkHealth).toHaveBeenCalledTimes(1)

    // Seen stopped: the status is still read, in case the read was wrong.
    watch.stopHealth()
    expect(jobIds()).toEqual(['container-watch.status:agent-a'])
    await vi.advanceTimersByTimeAsync(STATUS_MS - HEALTH_MS)
    expect(checkHealth).toHaveBeenCalledTimes(1)
    expect(checkStatus).toHaveBeenCalledTimes(1)

    watch.stop()
    expect(watch.isWatching()).toBe(false)
    expect(jobIds()).toEqual([])
    await vi.advanceTimersByTimeAsync(STATUS_MS * 2)
    expect(checkStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps one job of each kind when started twice, and starts again after a stop', async () => {
    const { watch, checkHealth } = watchOf('agent-a')
    watch.startHealth()
    watch.startHealth()
    await vi.advanceTimersByTimeAsync(HEALTH_MS)
    expect(checkHealth).toHaveBeenCalledTimes(1)

    watch.stop()
    expect(watch.isCheckingHealth()).toBe(false)
    watch.startHealth()
    await vi.advanceTimersByTimeAsync(HEALTH_MS)
    expect(checkHealth).toHaveBeenCalledTimes(2)
    watch.stop()
  })

  it('holds up only its own agent when a check hangs', async () => {
    let release = () => {}
    const stuck = watchOf('agent-a')
    stuck.checkHealth.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve() }))
    const other = watchOf('agent-b')
    stuck.watch.startHealth()
    other.watch.startHealth()

    await vi.advanceTimersByTimeAsync(HEALTH_MS * 3)
    // A pass that comes due while the last one runs is skipped, not queued.
    expect(stuck.checkHealth).toHaveBeenCalledTimes(1)
    expect(other.checkHealth).toHaveBeenCalledTimes(3)
    stuck.watch.stop()
    other.watch.stop()
    // Gives back the slot it held, for the tests after this one.
    release()
  })

  it('runs at most 4 checks of a kind at once, and none for a watch that stopped while it waited', async () => {
    const releases: Array<() => void> = []
    const agents = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => watchOf(`agent-${name}`))
    for (const { watch, checkHealth } of agents) {
      checkHealth.mockImplementation(() => new Promise<void>((resolve) => { releases.push(() => resolve()) }))
      watch.startHealth()
    }
    const calls = () => agents.map(({ checkHealth }) => checkHealth.mock.calls.length)

    // All six come due together: four run, two wait for a slot.
    await vi.advanceTimersByTimeAsync(HEALTH_MS)
    expect(calls()).toEqual([1, 1, 1, 1, 0, 0])

    // The last one's watch stops while it waits: its turn checks nothing.
    agents[5].watch.stop()
    releases.splice(0).forEach((release) => release())
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toEqual([1, 1, 1, 1, 1, 0])

    for (const { watch } of agents) watch.stop()
    releases.splice(0).forEach((release) => release())
  })

  it('starts nothing once dispatch has stopped', async () => {
    await stopBackgroundWork()
    const { watch } = watchOf('agent-a')
    watch.startHealth()
    expect(watch.isWatching()).toBe(false)
    expect(watch.isCheckingHealth()).toBe(false)
  })
})
