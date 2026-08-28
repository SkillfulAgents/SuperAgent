import { describe, it, expect, vi } from 'vitest'
import {
  PAGE_TARGET_RECHECK_MS,
  confirmNoPagesLeft,
  readTabSources,
  recheckPageTarget,
} from './browser-liveness'

describe('recheckPageTarget', () => {
  it('waits before looking again, so a tab that lags browser_open is still found', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const findTarget = vi.fn().mockResolvedValue({ id: 'page-1' })

    const target = await recheckPageTarget(findTarget, sleep)

    expect(sleep).toHaveBeenCalledWith(PAGE_TARGET_RECHECK_MS)
    expect(sleep.mock.invocationCallOrder[0]).toBeLessThan(findTarget.mock.invocationCallOrder[0])
    expect(target).toEqual({ id: 'page-1' })
  })

  it('reports no target when the second look also finds none', async () => {
    const findTarget = vi.fn().mockResolvedValue(null)

    expect(await recheckPageTarget(findTarget, async () => {})).toBeNull()
    expect(findTarget).toHaveBeenCalledTimes(1)
  })

  it('treats an unreachable CDP endpoint as no target rather than throwing', async () => {
    const findTarget = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(recheckPageTarget(findTarget, async () => {})).resolves.toBeNull()
  })
})

describe('readTabSources', () => {
  it('does not ask the daemon for tabs when Chrome reports no page', async () => {
    // Asking would MAKE one: agent-browser opens about:blank so it has
    // something to report, resurrecting the window the user just closed.
    const listDaemonTabs = vi.fn().mockResolvedValue([{ tabId: 't2', url: 'about:blank' }])

    const result = await readTabSources(async () => [], listDaemonTabs)

    expect(listDaemonTabs).not.toHaveBeenCalled()
    expect(result).toEqual({ allTargets: [], daemonTabs: [] })
  })

  it('reconciles both sources while Chrome still has a page', async () => {
    const listDaemonTabs = vi.fn().mockResolvedValue([{ tabId: 't1', url: 'https://example.com/' }])

    const result = await readTabSources(
      async () => [{ id: 'A', url: 'https://example.com/' }],
      listDaemonTabs,
    )

    expect(listDaemonTabs).toHaveBeenCalledTimes(1)
    expect(result.allTargets).toHaveLength(1)
    expect(result.daemonTabs).toHaveLength(1)
  })
})

describe('confirmNoPagesLeft', () => {
  it('confirms the close when Chrome answers with no page', async () => {
    expect(await confirmNoPagesLeft(async () => [])).toBe(true)
  })

  it('does not confirm when a page turned up after all', async () => {
    expect(await confirmNoPagesLeft(async () => [{ id: 'late-page' }])).toBe(false)
  })

  it('does not confirm when Chrome cannot be reached', async () => {
    // A transient outage fails the lenient lookups the same way a closed
    // browser does — without this, a network blip tears down a live browser.
    const strict = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    expect(await confirmNoPagesLeft(strict)).toBe(false)
  })
})
