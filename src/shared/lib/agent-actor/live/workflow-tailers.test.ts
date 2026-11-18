import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFilePath } from '../session-store'
import { createInMemorySessionStore } from '../testing/in-memory-session-store'
import type { SessionEvent } from './session-channel'
import { WorkflowTailers } from './workflow-tailers'

const SESSION = 'session-1'
const POLL_MS = 1000

const started = (agentId: string) => JSON.stringify({ type: 'started', key: agentId, agentId }) + '\n'
const result = (agentId: string, value: string) => JSON.stringify({ type: 'result', key: agentId, agentId, result: value }) + '\n'

function tailed() {
  const store = createInMemorySessionStore('agent-1')
  const events: SessionEvent[] = []
  const tailers = new WorkflowTailers(store, SESSION, (event) => events.push(event))
  const journal = (runId: string) => sessionFilePath(store, SESSION, 'subagents', 'workflows', runId, 'journal.jsonl')
  return {
    tailers,
    events,
    write: (runId: string, line: string) => store.files.append(journal(runId), line),
    agentsSeen: () => events.map((e) => `${e.runId}/${e.agentId}:${e.status}`),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkflowTailers', () => {
  it('follows a run\'s journal in the session\'s directory, emitting each agent transition', async () => {
    const t = tailed()
    await t.write('wf_1', started('a1'))

    t.tailers.start('wf_1')
    await vi.advanceTimersByTimeAsync(0)
    await t.write('wf_1', result('a1', 'done'))
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(t.events).toEqual([
      { type: 'workflow_agent_updated', runId: 'wf_1', agentId: 'a1', status: 'running', result: null },
      { type: 'workflow_agent_updated', runId: 'wf_1', agentId: 'a1', status: 'done', result: 'done' },
    ])
    t.tailers.stopAll()
  })

  it('follows a run once, however often it is started', async () => {
    const t = tailed()
    await t.write('wf_1', started('a1'))

    t.tailers.start('wf_1')
    t.tailers.start('wf_1')
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)

    expect(t.agentsSeen()).toEqual(['wf_1/a1:running'])
    t.tailers.stopAll()
  })

  it('follows several runs side by side', async () => {
    const t = tailed()
    await t.write('wf_1', started('a1'))
    await t.write('wf_2', started('b1'))

    t.tailers.start('wf_1')
    t.tailers.start('wf_2')
    await vi.advanceTimersByTimeAsync(0)

    expect(t.agentsSeen().sort()).toEqual(['wf_1/a1:running', 'wf_2/b1:running'])
    t.tailers.stopAll()
  })

  it('drains the journal once more when a run stops, then stops following it', async () => {
    const t = tailed()
    t.tailers.start('wf_1')
    await vi.advanceTimersByTimeAsync(0)
    // The last result can land just before the completion that stops the tailer.
    await t.write('wf_1', result('a1', 'final'))

    t.tailers.stop('wf_1')
    await vi.advanceTimersByTimeAsync(0)
    await t.write('wf_1', result('a2', 'too late'))
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)

    expect(t.agentsSeen()).toEqual(['wf_1/a1:done'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops following every run at once', async () => {
    const t = tailed()
    t.tailers.start('wf_1')
    t.tailers.start('wf_2')
    await vi.advanceTimersByTimeAsync(0)

    t.tailers.stopAll()
    await vi.advanceTimersByTimeAsync(0)
    await t.write('wf_1', started('a1'))
    await t.write('wf_2', started('b1'))
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)

    expect(t.events).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats stopping a run it does not follow as a no-op', () => {
    const t = tailed()

    expect(() => t.tailers.stop('wf_unknown')).not.toThrow()
  })
})
