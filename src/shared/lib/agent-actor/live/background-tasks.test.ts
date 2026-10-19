import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTasksSnapshot } from '@shared/lib/container/background-tasks-changed'
import { BackgroundTasks, isTerminalTaskStatus } from './background-tasks'
import type { SessionEvent } from './session-channel'

const SESSION = { agentSlug: 'agent-1', sessionId: 'session-1' }
const T0 = new Date('2026-10-19T10:00:00Z').getTime()

/** A tracker over a sink that records what clients, the feed and the journal tailers heard. */
function tracked() {
  const events: SessionEvent[] = []
  const published: Array<{ type: string; [key: string]: unknown }> = []
  const workflows: Array<['started' | 'ended', string]> = []
  const tasks = new BackgroundTasks(SESSION, {
    emit: (event) => events.push(event),
    publish: (event) => published.push(event),
    workflowStarted: (runId) => workflows.push(['started', runId]),
    workflowEnded: (runId) => workflows.push(['ended', runId]),
  })
  return {
    tasks,
    events,
    published,
    workflows,
    types: () => events.map((e) => e.type),
    reset: () => {
      events.length = 0
      published.length = 0
      workflows.length = 0
    },
  }
}

type LevelSetTask = BackgroundTasksSnapshot['tasks'][number]
const levelSet = (...tasks: LevelSetTask[]): BackgroundTasksSnapshot => ({
  taskIds: new Set(tasks.map((t) => t.task_id)),
  tasks,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('isTerminalTaskStatus', () => {
  it('names the statuses that end a task', () => {
    for (const status of ['completed', 'failed', 'killed', 'stopped']) expect(isTerminalTaskStatus(status)).toBe(true)
    for (const status of ['running', 'paused', '', undefined, 3]) expect(isTerminalTaskStatus(status)).toBe(false)
  })
})

describe('BackgroundTasks', () => {
  describe('registering a task', () => {
    it('tells clients, with the whole list, and the global feed', () => {
      const { tasks, events, published } = tracked()

      tasks.upsert('bash-1', { taskType: 'local_bash', description: 'npm run dev' })

      const row = { taskId: 'bash-1', startedAt: T0, taskType: 'local_bash', description: 'npm run dev' }
      expect(tasks.list()).toEqual([expect.objectContaining(row)])
      expect(events).toEqual([
        { type: 'background_task_started', ...tasks.list()[0], backgroundTasks: tasks.list() },
      ])
      expect(published).toEqual([{ type: 'background_task_started', sessionId: 'session-1', agentSlug: 'agent-1', taskId: 'bash-1' }])
    })

    it('merges what a later signal knows into the entry, keeping its start time', () => {
      const { tasks, events, published, reset } = tracked()
      tasks.upsert('agent-1', { isSubagent: true, toolUseId: 'toolu_1' })
      reset()
      vi.setSystemTime(T0 + 5_000)

      tasks.upsert('agent-1', { taskType: 'local_agent', description: 'Research', isSubagent: undefined })

      expect(tasks.get('agent-1')).toEqual({
        startedAt: T0,
        isSubagent: true,
        toolUseId: 'toolu_1',
        taskType: 'local_agent',
        description: 'Research',
      })
      expect(events).toEqual([
        {
          type: 'background_task_updated',
          taskId: 'agent-1',
          startedAt: T0,
          isWorkflow: undefined,
          isSubagent: true,
          taskType: 'local_agent',
          description: 'Research',
          subagentType: undefined,
          backgroundTasks: tasks.list(),
        },
      ])
      expect(published).toEqual([])
    })

    it('says nothing when a signal changes nothing clients render', () => {
      const { tasks, events, reset } = tracked()
      tasks.upsert('wf-task', { isWorkflow: true, taskType: 'local_workflow' })
      reset()

      tasks.upsert('wf-task', { toolUseId: 'toolu_9', workflowName: 'deploy' })
      tasks.upsert('wf-task', { isWorkflow: true })

      expect(events).toEqual([])
      expect(tasks.get('wf-task')).toMatchObject({ toolUseId: 'toolu_9', workflowName: 'deploy' })
    })
  })

  describe('ambient tasks', () => {
    it('counts an ambient task as live work but never shows it', () => {
      const { tasks, events, published } = tracked()

      tasks.upsert('watcher', { ambient: true })

      expect(tasks.list()).toEqual([])
      expect(tasks.openCount()).toBe(1)
      expect(events).toEqual([])
      expect(published).toEqual([])
    })

    it('drops a task that turns ambient from the list, as if it ended', () => {
      const { tasks, events, published, reset } = tracked()
      tasks.upsert('bash-1', { taskType: 'local_bash' })
      reset()

      tasks.upsert('bash-1', { ambient: true })

      expect(events).toEqual([{ type: 'background_task_completed', taskId: 'bash-1', backgroundTasks: [] }])
      expect(published).toEqual([{ type: 'background_task_completed', sessionId: 'session-1', agentSlug: 'agent-1', taskId: 'bash-1' }])
      expect(tasks.openCount()).toBe(1)
    })

    it('adds a task that turns back from ambient to the list', () => {
      const { tasks, types, published, reset } = tracked()
      tasks.upsert('bash-1', { ambient: true })
      reset()

      tasks.upsert('bash-1', { ambient: false })

      expect(types()).toEqual(['background_task_started'])
      expect(published.map((e) => e.type)).toEqual(['background_task_started'])
      expect(tasks.list().map((t) => t.taskId)).toEqual(['bash-1'])
    })

    it('ends an ambient task quietly: it was never news to clients', () => {
      const { tasks, events, published, reset } = tracked()
      tasks.upsert('watcher', { ambient: true })
      reset()

      expect(tasks.clear('watcher')).toBe(true)

      expect(events).toEqual([])
      expect(published).toEqual([])
      expect(tasks.openCount()).toBe(0)
    })
  })

  describe('liveness', () => {
    it('rests on the registered tasks alone before any level set', () => {
      const { tasks } = tracked()
      tasks.upsert('a', {})
      tasks.upsert('b', {})

      expect(tasks.openCount()).toBe(2)
    })

    it('is the union of the registered tasks and the level set', () => {
      const { tasks } = tracked()
      tasks.applyLevelSet(levelSet({ task_id: 'a', task_type: 'local_bash' }))

      // task_started can lead the level set that will list it.
      tasks.upsert('b', {})

      expect(tasks.openCount()).toBe(2)
    })
  })

  describe('a terminal signal', () => {
    it('ends a task with no level set to weigh it against', () => {
      const { tasks, types } = tracked()
      tasks.upsert('bash-1', {})

      tasks.retire('bash-1', 'completed')

      expect(tasks.get('bash-1')).toBeUndefined()
      expect(types()).toEqual(['background_task_started', 'background_task_completed'])
    })

    it('leaves a completed task the level set still lists for the level set to retire', () => {
      const { tasks, types, reset } = tracked()
      tasks.applyLevelSet(levelSet({ task_id: 'agent-1', task_type: 'local_agent' }))
      reset()

      tasks.retire('agent-1', 'completed')

      expect(tasks.get('agent-1')).toBeDefined()
      expect(tasks.openCount()).toBe(1)
      expect(types()).toEqual([])

      tasks.applyLevelSet(levelSet())

      expect(tasks.get('agent-1')).toBeUndefined()
      expect(tasks.openCount()).toBe(0)
      expect(types()).toEqual(['background_task_completed'])
    })

    it('ends a listed task outright for any other terminal status', () => {
      for (const status of ['failed', 'killed', 'stopped']) {
        const { tasks } = tracked()
        tasks.applyLevelSet(levelSet({ task_id: 'bash-1', task_type: 'local_bash' }))

        tasks.retire('bash-1', status)

        expect(tasks.get('bash-1')).toBeUndefined()
        expect(tasks.openCount()).toBe(0)
      }
    })
  })

  describe('clearing a task', () => {
    it('drops it from both sides, so a removal frame that never comes cannot pin the session', () => {
      const { tasks } = tracked()
      tasks.applyLevelSet(levelSet({ task_id: 'bash-1', task_type: 'local_bash' }))

      expect(tasks.clear('bash-1')).toBe(true)

      expect(tasks.openCount()).toBe(0)
    })

    it('drops an id only the level set knows, and reports the map never held it', () => {
      const { tasks, events } = tracked()
      tasks.applyLevelSet(levelSet({ task_id: 'bash-1', task_type: 'local_bash' }))
      tasks.forgetAll()
      tasks.applyLevelSet(levelSet({ task_id: 'bash-1', task_type: 'local_bash' }))
      tasks.clear('bash-1')
      events.length = 0

      expect(tasks.clear('bash-1')).toBe(false)
      expect(tasks.clear('never-seen')).toBe(false)
      expect(events).toEqual([])
    })

    it('ends a workflow\'s journal following when it ends', () => {
      const { tasks, events, workflows, reset } = tracked()
      tasks.upsert('wf-task', { isWorkflow: true, toolUseId: 'toolu_wf', workflowName: 'deploy' })
      tasks.wireWorkflowFromToolResult({
        tool_use_result: { taskType: 'local_workflow', runId: 'wf_abc' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: 'started' }] },
      })
      reset()

      tasks.clear('wf-task')

      expect(events).toEqual([
        { type: 'background_task_completed', taskId: 'wf-task', backgroundTasks: [] },
        { type: 'workflow_completed', runId: 'wf_abc' },
      ])
      expect(workflows).toEqual([['ended', 'wf_abc']])
    })

    it('has no journal to stop for a workflow whose run id was never learned', () => {
      const { tasks, types, workflows, reset } = tracked()
      tasks.upsert('wf-task', { isWorkflow: true, toolUseId: 'toolu_wf' })
      reset()

      tasks.clear('wf-task')

      expect(types()).toEqual(['background_task_completed'])
      expect(workflows).toEqual([])
    })
  })

  describe('a level set', () => {
    it('gives every task it lists a row, labelled by the SDK, even one no launch signal registered', () => {
      const { tasks, types } = tracked()

      tasks.applyLevelSet(levelSet(
        { task_id: 'bash-1', task_type: 'local_bash', description: 'npm run dev' },
        { task_id: 'agent-1', task_type: 'local_agent', description: 'Research', subagent_type: 'researcher' },
        { task_id: 'wf-1', task_type: 'local_workflow', description: 'Deploy' },
      ))

      expect(tasks.list()).toEqual([
        { taskId: 'bash-1', startedAt: T0, isWorkflow: undefined, isSubagent: undefined, taskType: 'local_bash', description: 'npm run dev', subagentType: undefined },
        { taskId: 'agent-1', startedAt: T0, isWorkflow: undefined, isSubagent: true, taskType: 'local_agent', description: 'Research', subagentType: 'researcher' },
        { taskId: 'wf-1', startedAt: T0, isWorkflow: true, isSubagent: undefined, taskType: 'local_workflow', description: 'Deploy', subagentType: undefined },
      ])
      expect(types()).toEqual(['background_task_started', 'background_task_started', 'background_task_started'])
    })

    it('returns the ids it names as subagents', () => {
      const { tasks } = tracked()

      const subagents = tasks.applyLevelSet(levelSet(
        { task_id: 'bash-1', task_type: 'local_bash' },
        { task_id: 'agent-1', task_type: 'local_agent' },
        { task_id: 'agent-2', task_type: 'local_agent', ambient: true },
      ))

      expect(subagents).toEqual(['agent-1', 'agent-2'])
    })

    it('retires a registered task it no longer lists, as its missed terminal signal would', () => {
      const { tasks, events, reset } = tracked()
      tasks.upsert('bash-1', {})
      tasks.upsert('bash-2', {})
      reset()

      tasks.applyLevelSet(levelSet({ task_id: 'bash-2', task_type: 'local_bash' }))

      expect(tasks.get('bash-1')).toBeUndefined()
      expect(events[0]).toEqual({
        type: 'background_task_completed',
        taskId: 'bash-1',
        backgroundTasks: [expect.objectContaining({ taskId: 'bash-2' })],
      })
      expect(tasks.openCount()).toBe(1)
    })

    it('leaves the terminal signal that follows its removal nothing to do', () => {
      const { tasks, types, reset } = tracked()
      tasks.applyLevelSet(levelSet({ task_id: 'bash-1', task_type: 'local_bash' }))
      tasks.applyLevelSet(levelSet())
      reset()

      tasks.retire('bash-1', 'completed')

      expect(types()).toEqual([])
    })

    it('decides the ambient flag, so a flip back to activity may come as an absent field', () => {
      const { tasks } = tracked()
      tasks.applyLevelSet(levelSet({ task_id: 'watcher', task_type: 'local_bash', ambient: true }))
      expect(tasks.list()).toEqual([])

      tasks.applyLevelSet(levelSet({ task_id: 'watcher', task_type: 'local_bash' }))

      expect(tasks.list().map((t) => t.taskId)).toEqual(['watcher'])
    })

    it('keeps what launch signals knew about a task it re-lists', () => {
      const { tasks } = tracked()
      tasks.upsert('wf-1', { isWorkflow: true, toolUseId: 'toolu_wf', workflowName: 'deploy' })

      tasks.applyLevelSet(levelSet({ task_id: 'wf-1', task_type: 'local_workflow' }))

      expect(tasks.get('wf-1')).toMatchObject({ isWorkflow: true, toolUseId: 'toolu_wf', workflowName: 'deploy', ambient: false })
    })
  })

  describe('the CLI process', () => {
    it('adopts the first process it is told of without dropping anything', () => {
      const { tasks, reset, events } = tracked()
      tasks.upsert('bash-1', {})
      reset()

      tasks.adoptProcessInstance('proc-1')

      expect(tasks.processInstanceId).toBe('proc-1')
      expect(tasks.get('bash-1')).toBeDefined()
      expect(events).toEqual([])
    })

    it('keeps its tasks when a reattach re-announces the same process', () => {
      const { tasks } = tracked()
      tasks.adoptProcessInstance('proc-1')
      tasks.upsert('bash-1', {})

      tasks.adoptProcessInstance('proc-1')

      expect(tasks.get('bash-1')).toBeDefined()
    })

    it('drops every task, telling clients, when the handshake names a different process', () => {
      const { tasks, types, reset } = tracked()
      tasks.adoptProcessInstance('proc-1')
      tasks.applyLevelSet(levelSet({ task_id: 'bash-1', task_type: 'local_bash' }, { task_id: 'bash-2', task_type: 'local_bash' }))
      reset()

      tasks.adoptProcessInstance('proc-2')

      expect(tasks.processInstanceId).toBe('proc-2')
      expect(tasks.openCount()).toBe(0)
      expect(types()).toEqual(['background_task_completed', 'background_task_completed'])
    })

    it('ignores a handshake too old to name its process', () => {
      const { tasks } = tracked()
      tasks.adoptProcessInstance('proc-1')
      tasks.upsert('bash-1', {})

      tasks.adoptProcessInstance(undefined)
      tasks.adoptProcessInstance('')

      expect(tasks.processInstanceId).toBe('proc-1')
      expect(tasks.get('bash-1')).toBeDefined()
    })

    it('resets on process_restarted, whether or not the outgoing process was recorded', () => {
      const { tasks, types, reset } = tracked()
      tasks.applyLevelSet(levelSet({ task_id: 'bash-1', task_type: 'local_bash' }))
      reset()

      tasks.processRestarted('proc-2')

      expect(tasks.processInstanceId).toBe('proc-2')
      expect(tasks.openCount()).toBe(0)
      expect(types()).toEqual(['background_task_completed'])
    })

    it('resets on a process_restarted that does not name the new process', () => {
      const { tasks } = tracked()
      tasks.adoptProcessInstance('proc-1')
      tasks.upsert('bash-1', {})

      tasks.processRestarted(undefined)

      expect(tasks.openCount()).toBe(0)
    })

    it('forgets everything without a word when the runtime is gone', () => {
      const { tasks, events, published, reset } = tracked()
      tasks.applyLevelSet(levelSet({ task_id: 'bash-1', task_type: 'local_bash' }))
      tasks.upsert('bash-2', {})
      reset()

      tasks.forgetAll()

      expect(tasks.openCount()).toBe(0)
      expect(tasks.list()).toEqual([])
      expect(events).toEqual([])
      expect(published).toEqual([])
    })
  })

  describe('workflows', () => {
    const launched = () => {
      const t = tracked()
      t.tasks.upsert('wf-task', { isWorkflow: true, toolUseId: 'toolu_wf', workflowName: 'deploy' })
      t.reset()
      return t
    }

    it('learns a workflow\'s run id from its tool result\'s structured field, and starts following its journal', () => {
      const { tasks, events, workflows } = launched()

      tasks.wireWorkflowFromToolResult({
        tool_use_result: { taskType: 'local_workflow', runId: 'wf_abc' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: 'ok' }] },
      })

      expect(tasks.workflowRunIdFor('toolu_wf')).toBe('wf_abc')
      expect(events).toEqual([{ type: 'workflow_started', toolUseId: 'toolu_wf', runId: 'wf_abc', name: 'deploy', startedAt: T0 }])
      expect(workflows).toEqual([['started', 'wf_abc']])
    })

    it('reads the run id from the result text when the structured field is missing', () => {
      for (const text of ['Workflow launched. Run ID: wf_run-1_x', 'See subagents/workflows/wf_run-1_x/journal.jsonl']) {
        const { tasks, workflows } = launched()

        tasks.wireWorkflowFromToolResult({
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: text }] },
        })

        expect(workflows).toEqual([['started', 'wf_run-1_x']])
      }
    })

    it('wires a workflow once', () => {
      const { tasks, workflows } = launched()
      const result = {
        tool_use_result: { taskType: 'local_workflow', runId: 'wf_abc' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: 'ok' }] },
      }

      tasks.wireWorkflowFromToolResult(result)
      tasks.wireWorkflowFromToolResult({ ...result, tool_use_result: { taskType: 'local_workflow', runId: 'wf_other' } })

      expect(workflows).toEqual([['started', 'wf_abc']])
      expect(tasks.workflowRunIdFor('toolu_wf')).toBe('wf_abc')
    })

    it('ignores a result for a call that launched no workflow, or one that names no run', () => {
      const { tasks, events, workflows } = launched()
      tasks.upsert('bash-1', { toolUseId: 'toolu_bash' })
      events.length = 0

      tasks.wireWorkflowFromToolResult({
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'Run ID: wf_abc' }] },
      })
      tasks.wireWorkflowFromToolResult({
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: 'no id here' }] },
      })
      tasks.wireWorkflowFromToolResult({ message: { content: 'not blocks' } })
      tasks.wireWorkflowFromToolResult(undefined)

      expect(events).toEqual([])
      expect(workflows).toEqual([])
      expect(tasks.workflowRunIdFor('toolu_wf')).toBeUndefined()
      expect(tasks.workflowRunIdFor('toolu_unknown')).toBeUndefined()
    })
  })
})
