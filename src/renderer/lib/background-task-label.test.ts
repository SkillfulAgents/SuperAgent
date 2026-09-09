import { describe, it, expect } from 'vitest'
import { labelBackgroundTasks } from './background-task-label'

const message = (toolCalls: unknown[]) => ({
  id: 'm1',
  type: 'assistant' as const,
  content: { text: '' },
  toolCalls,
  createdAt: new Date(),
})

describe('labelBackgroundTasks', () => {
  it('uses the name the stream carried when the transcript has no launching call', () => {
    // A task a subagent launched: its Bash call is in the subagent's own
    // transcript, so the host names it on background_task_started.
    const [task] = labelBackgroundTasks(
      [{
        taskId: 'bg_nested',
        startedAt: 1,
        launchedBySubagent: true,
        label: { title: 'Background command', detail: 'python -m http.server 8080' },
      }],
      [message([])] as never,
    )
    expect(task).toMatchObject({ taskId: 'bg_nested', title: 'Background command', detail: 'python -m http.server 8080' })
  })

  it('prefers the transcript over the stream label when both name a task', () => {
    const [task] = labelBackgroundTasks(
      [{ taskId: 'bg_both', startedAt: 1, label: { title: 'Background command', detail: 'from the stream' } }],
      [message([{ id: 'tc1', name: 'Bash', input: { command: 'from the transcript' }, result: '', backgroundTaskId: 'bg_both' }])] as never,
    )
    expect(task.detail).toBe('from the transcript')
  })

  it('names a backgrounded Bash task after its command', () => {
    const [task] = labelBackgroundTasks(
      [{ taskId: 'bg_abc', startedAt: 1 }],
      [message([{
        id: 'tc1',
        name: 'Bash',
        input: { command: 'npm test', run_in_background: true },
        result: 'Command running in background with ID: bg_abc. Output is being written to /tmp/o.',
      }])] as never,
    )
    expect(task).toMatchObject({ taskId: 'bg_abc', title: 'Background command', detail: 'npm test' })
  })

  it('prefers the background task id the API carries on the call', () => {
    // A backgrounded command's result is its (empty) stdout, so the text
    // fallback has nothing to match — the id on the call is what names it.
    const [task] = labelBackgroundTasks(
      [{ taskId: 'bg_api', startedAt: 1 }],
      [message([{
        id: 'tc1',
        name: 'Bash',
        input: { command: 'make all', run_in_background: true },
        result: '',
        backgroundTaskId: 'bg_api',
      }])] as never,
    )
    expect(task).toMatchObject({ title: 'Background command', detail: 'make all' })
  })

  it('reads the task id out of a tool result given as content blocks', () => {
    const [task] = labelBackgroundTasks(
      [{ taskId: 'bg_xyz', startedAt: 1 }],
      [message([{
        id: 'tc1',
        name: 'Bash',
        input: { command: 'sleep 5' },
        result: [{ type: 'text', text: 'Command running in background with ID: bg_xyz.' }],
      }])] as never,
    )
    expect(task.detail).toBe('sleep 5')
  })

  it('names a background subagent after its type and description', () => {
    const [task] = labelBackgroundTasks(
      [{ taskId: 'agent-1', startedAt: 1, isSubagent: true }],
      [message([{
        id: 'tc1',
        name: 'Agent',
        input: { subagent_type: 'Explore', description: 'Find the config loader' },
        subagent: { agentId: 'agent-1', status: 'async_launched' },
      }])] as never,
    )
    expect(task).toMatchObject({ title: 'Explore', detail: 'Find the config loader' })
  })

  it('falls back to a generic label per kind when the transcript has no launch', () => {
    const tasks = labelBackgroundTasks(
      [
        { taskId: 'a', startedAt: 1 },
        { taskId: 'b', startedAt: 1, isWorkflow: true },
        { taskId: 'c', startedAt: 1, isSubagent: true },
      ],
      undefined,
    )
    expect(tasks.map((t) => t.title)).toEqual(['Background command', 'Background workflow', 'Background agent'])
    expect(tasks.every((t) => t.detail === null)).toBe(true)
  })

  it('returns nothing for no tasks without touching the transcript', () => {
    expect(labelBackgroundTasks([], [message([])] as never)).toEqual([])
  })
})
