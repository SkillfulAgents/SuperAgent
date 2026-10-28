import { describe, it, expect } from 'vitest'
import { parseTaskNotifications } from './task-notifications'

describe('parseTaskNotifications', () => {
  it('passes through text with no notifications', () => {
    const { cleanText, workflowResults } = parseTaskNotifications('Just a normal reply.')
    expect(cleanText).toBe('Just a normal reply.')
    expect(workflowResults).toEqual([])
  })

  it('strips a bare status-only notification (real busy-path shape)', () => {
    const input =
      "The workflow is running — I'll report when it completes.\n\n<task-notification>Task wbvdjkgtn completed</task-notification>"
    const { cleanText, workflowResults } = parseTaskNotifications(input)
    expect(cleanText).toBe("The workflow is running — I'll report when it completes.")
    expect(cleanText).not.toContain('task-notification')
    expect(workflowResults).toEqual([])
  })

  it('extracts a workflow-complete result and strips the raw block (real shape)', () => {
    const input =
      'Working on it.\n\n<task-notification id="w77wo334c" type="workflow-complete" title="Workflow completed" runId="wf_1244fc66-44e">{"result":"Our solar system is wild.","completedAt":"2026-06-23T05:30:32.221Z"}</task-notification>'
    const { cleanText, workflowResults } = parseTaskNotifications(input)
    expect(cleanText).toBe('Working on it.')
    expect(cleanText).not.toContain('task-notification')
    expect(workflowResults).toEqual([
      {
        runId: 'wf_1244fc66-44e',
        title: 'Workflow completed',
        result: 'Our solar system is wild.',
        completedAt: '2026-06-23T05:30:32.221Z',
      },
    ])
  })

  it('extracts an attribute-less JSON-body notification (workflow_completed / run_id shape)', () => {
    // Real third-format shape: no XML attrs; type/run_id/result live in the JSON body.
    const input =
      'On it.\n\n<task-notification>{"task_id":"wbpoha88l","type":"workflow_completed","run_id":"wf_8914eb0b-603","result":"Our solar system is wild.","status":"completed"} </task-notification>'
    const { cleanText, workflowResults } = parseTaskNotifications(input)
    expect(cleanText).toBe('On it.')
    expect(cleanText).not.toContain('task-notification')
    expect(workflowResults).toEqual([
      { runId: 'wf_8914eb0b-603', title: undefined, result: 'Our solar system is wild.', completedAt: undefined },
    ])
  })

  it('drops a malformed workflow-complete payload without surfacing raw XML', () => {
    const input = 'Hi.\n\n<task-notification type="workflow-complete">not json</task-notification>'
    const { cleanText, workflowResults } = parseTaskNotifications(input)
    expect(cleanText).toBe('Hi.')
    expect(cleanText).not.toContain('task-notification')
    expect(workflowResults).toEqual([])
  })

  it('handles multiple blocks and collapses leftover blank lines', () => {
    const input =
      'Start.\n\n<task-notification>Task a completed</task-notification>\n\n<task-notification type="workflow-complete" runId="wf_2">{"result":"done"}</task-notification>\n\nEnd.'
    const { cleanText, workflowResults } = parseTaskNotifications(input)
    expect(cleanText).toBe('Start.\n\nEnd.')
    expect(workflowResults).toHaveLength(1)
    expect(workflowResults[0]).toMatchObject({ runId: 'wf_2', result: 'done' })
  })
})
