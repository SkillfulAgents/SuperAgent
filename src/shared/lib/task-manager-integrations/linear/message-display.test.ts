import { describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../types'
import { describeLinearIssue } from './message-display'

const snapshot: TaskSnapshot = {
  id: 'issue', identifier: 'SUP-879', title: 'Shared renderer', description: '', url: 'https://linear.app/acme/issue/SUP-879',
  updatedAt: '2026-09-22T00:00:00.000Z', comments: [], attachments: [], truncated: false,
  // The shape LinearTasks.snapshot builds.
  properties: {
    state: { id: 's', name: 'In Progress', type: 'started' },
    team: { id: 't', name: 'Superagents', states: { nodes: [] } },
    priority: 2,
    assignee: { id: 'u', name: 'Iddo' },
    delegate: { id: 'a', name: 'Release bot' },
    project: { id: 'p', name: 'Gamut NG' },
    labels: [{ id: 'l1', name: 'Frontend' }, { id: 'l2', name: 'Design' }],
  },
}

describe('describeLinearIssue', () => {
  it('maps the snapshot properties onto the ticket preview', () => {
    expect(describeLinearIssue(snapshot)).toEqual({
      status: { name: 'In Progress', category: 'started' },
      priority: { level: 2, label: 'High' },
      assignee: 'Iddo', delegate: 'Release bot', team: 'Superagents', project: 'Gamut NG',
      labels: ['Frontend', 'Design'],
    })
  })

  it('omits what is missing and drops an unknown workflow type', () => {
    const sparse = { ...snapshot, properties: { state: { name: 'Custom', type: 'mystery' }, priority: 0, assignee: null, project: null, labels: [] } }
    expect(describeLinearIssue(sparse)).toEqual({ status: { name: 'Custom' }, priority: { level: 0, label: 'No priority' } })
  })

  it('yields no fields for a snapshot it does not recognize', () => {
    expect(describeLinearIssue({ ...snapshot, properties: { priority: 'high' } })).toEqual({})
  })
})
