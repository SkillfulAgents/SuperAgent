import { describe, it, expect } from 'vitest'
import {
  createBackgroundTaskLiveness,
  hasOpenBackgroundWork,
  openBackgroundWorkCount,
  parseBackgroundTasksChanged,
  trackBackgroundTaskMessage,
} from './background-task-liveness'

describe('parseBackgroundTasksChanged', () => {
  it('parses a valid snapshot', () => {
    const snap = parseBackgroundTasksChanged({
      tasks: [{ task_id: 'a', task_type: 'local_bash' }, { task_id: 'b' }],
    })
    expect(snap).not.toBeNull()
    expect([...snap!.taskIds].sort()).toEqual(['a', 'b'])
  })

  it('returns null for a malformed frame', () => {
    expect(parseBackgroundTasksChanged({ tasks: 'nope' })).toBeNull()
    expect(parseBackgroundTasksChanged({})).toBeNull()
  })
})

describe('trackBackgroundTaskMessage', () => {
  it('uses snapshot membership as authoritative liveness', () => {
    const state = createBackgroundTaskLiveness()
    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1' }],
    })
    expect(hasOpenBackgroundWork(state)).toBe(true)

    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
    })
    expect(hasOpenBackgroundWork(state)).toBe(false)
  })

  it('unions snapshot with incremental around the lead-frame race', () => {
    const state = createBackgroundTaskLiveness()
    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'from-snap' }],
    })
    trackBackgroundTaskMessage(state, {
      type: 'user',
      tool_use_result: { backgroundTaskId: 'from-tool' },
    })
    expect(openBackgroundWorkCount(state)).toBe(2)
  })

  it('self-heals sticky incremental ids missing from a later snapshot', () => {
    const state = createBackgroundTaskLiveness()
    trackBackgroundTaskMessage(state, {
      type: 'user',
      tool_use_result: { backgroundTaskId: 'sticky' },
    })
    expect(hasOpenBackgroundWork(state)).toBe(true)

    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
    })
    expect(hasOpenBackgroundWork(state)).toBe(false)
    expect(state.incremental.has('sticky')).toBe(false)
  })

  it('registers bg Bash / async Agent / local_workflow; ignores foreground agent task_started', () => {
    const state = createBackgroundTaskLiveness()

    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'task_started',
      task_id: 'fg-agent',
      task_type: 'local_agent',
    })
    expect(hasOpenBackgroundWork(state)).toBe(false)

    trackBackgroundTaskMessage(state, {
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bash-1' },
    })
    trackBackgroundTaskMessage(state, {
      type: 'user',
      tool_use_result: { status: 'async_launched', agentId: 'agent-bg' },
    })
    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'task_started',
      task_id: 'wf-1',
      task_type: 'local_workflow',
    })
    expect(openBackgroundWorkCount(state)).toBe(3)

    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bash-1',
      status: 'completed',
    })
    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent-bg',
      patch: { status: 'failed' },
    })
    expect(openBackgroundWorkCount(state)).toBe(1)
  })

  it('ignores malformed snapshots without clearing incremental work', () => {
    const state = createBackgroundTaskLiveness()
    trackBackgroundTaskMessage(state, {
      type: 'user',
      tool_use_result: { backgroundTaskId: 'keep' },
    })
    trackBackgroundTaskMessage(state, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: 'bad',
    })
    expect(hasOpenBackgroundWork(state)).toBe(true)
    expect(state.snapshot).toBeNull()
  })
})
