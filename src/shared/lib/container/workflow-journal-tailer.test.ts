import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { WorkflowJournalTailer, type WorkflowAgentUpdate } from './workflow-journal-tailer'

const FIXTURE_ROOT = path.join(__dirname, '__fixtures__', 'local-workflow-capture-probe')
const SID = 'd63a9cbc-2f5e-44dd-8017-231ac99bef35'
const RUN = 'wf_818f758a-c17'

function tailer(runId: string, sink: WorkflowAgentUpdate[]) {
  return new WorkflowJournalTailer({
    sessionsDir: FIXTURE_ROOT,
    sessionId: SID,
    runId,
    emit: (e) => sink.push(e),
  })
}

describe('WorkflowJournalTailer', () => {
  it('emits a running then done event per agent from the real journal', async () => {
    const events: WorkflowAgentUpdate[] = []
    await tailer(RUN, events).pollOnce()

    expect(events).toHaveLength(6) // 3 agents × (started + result)
    expect(events.every((e) => e.type === 'workflow_agent_updated' && e.runId === RUN)).toBe(true)
    const statusesFor = (id: string) => events.filter((e) => e.agentId === id).map((e) => e.status)
    expect(statusesFor('ae6ffae379942dd19')).toEqual(['running', 'done'])
    const concatDone = events.find((e) => e.agentId === 'a7720e731ec4c42db' && e.status === 'done')
    expect(concatDone?.result).toBe('alpha-beta')
    const runningEvent = events.find((e) => e.status === 'running')
    expect(runningEvent?.result).toBeNull()
  })

  it('does not re-emit already-seen lines on a second poll', async () => {
    const events: WorkflowAgentUpdate[] = []
    const t = tailer(RUN, events)
    await t.pollOnce()
    const after = events.length
    await t.pollOnce()
    expect(events.length).toBe(after)
  })

  it('emits nothing when the journal does not exist yet', async () => {
    const events: WorkflowAgentUpdate[] = []
    await tailer('wf_missing', events).pollOnce()
    expect(events).toHaveLength(0)
  })
})
