import { describe, expect, it } from 'vitest'
import { AgentWidgetRefreshes, type WidgetRefreshOutcome } from './agent-widget-refreshes'

const failed: WidgetRefreshOutcome = { ok: false, error: 'script exited 1' }

describe('AgentWidgetRefreshes', () => {
  it('one refresh per widget at a time; joiners get its outcome, and when it ended is noted', async () => {
    const refreshes = new AgentWidgetRefreshes()
    const token = refreshes.begin('macros')!
    expect(refreshes.begin('macros')).toBeNull()
    expect(refreshes.begin('weather')).not.toBeNull()
    expect(refreshes.refreshing().sort()).toEqual(['macros', 'weather'])

    const joined = refreshes.beginOrJoin('macros')
    refreshes.finish('macros', 'not-the-token', failed)
    expect(refreshes.refreshing()).toContain('macros')
    refreshes.finish('macros', token, failed, 1_000)

    await expect(joined).resolves.toEqual({ outcome: failed })
    expect(refreshes.refreshing()).toEqual(['weather'])
    expect(refreshes.refreshedAt()).toEqual({ macros: 1_000 })
  })

  it('beginOrJoin starts a refresh when none is in flight, and the next caller joins it', async () => {
    const refreshes = new AgentWidgetRefreshes()
    const started = await refreshes.beginOrJoin('macros')
    expect(started).toEqual({ token: expect.any(String) })
    expect(refreshes.refreshing()).toEqual(['macros'])
    const joined = refreshes.beginOrJoin('macros')
    refreshes.finish('macros', (started as { token: string }).token, failed)
    await expect(joined).resolves.toEqual({ outcome: failed })
    // Over: the next caller starts afresh.
    await expect(refreshes.beginOrJoin('macros')).resolves.toEqual({ token: expect.any(String) })
  })

  it('a stale sweep runs at most once per throttle window', () => {
    const refreshes = new AgentWidgetRefreshes()
    expect(refreshes.claimStaleSweep(30_000, 100_000)).toBe(true)
    expect(refreshes.claimStaleSweep(30_000, 110_000)).toBe(false)
    // A forced sweep (no throttle) always runs, and restarts the window.
    expect(refreshes.claimStaleSweep(0, 115_000)).toBe(true)
    expect(refreshes.claimStaleSweep(30_000, 140_000)).toBe(false)
    expect(refreshes.claimStaleSweep(30_000, 145_000)).toBe(true)
  })

  it('only the newest run end is due a post-run sweep', () => {
    const refreshes = new AgentWidgetRefreshes()
    const first = refreshes.notePostRun()
    const second = refreshes.notePostRun()
    expect(refreshes.isLatestPostRun(first)).toBe(false)
    expect(refreshes.isLatestPostRun(second)).toBe(true)
  })

  it('dispose answers whoever joined a refresh in flight and forgets everything', async () => {
    const refreshes = new AgentWidgetRefreshes()
    const token = refreshes.begin('macros')!
    refreshes.finish('macros', token, failed)
    refreshes.begin('macros')
    const joined = refreshes.beginOrJoin('macros')
    const stamp = refreshes.notePostRun()
    refreshes.dispose()
    await expect(joined).resolves.toMatchObject({ outcome: { ok: false, error: expect.stringMatching(/no longer held/) } })
    expect(refreshes.refreshing()).toEqual([])
    expect(refreshes.refreshedAt()).toEqual({})
    // A post-run sweep scheduled before the agent went is not due any more.
    expect(refreshes.isLatestPostRun(stamp)).toBe(false)
  })
})
