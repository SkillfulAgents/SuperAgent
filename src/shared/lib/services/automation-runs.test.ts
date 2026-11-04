import { describe, expect, it } from 'vitest'
import { automationRunsAsMetadata, automationRunsOf } from './automation-runs'

const NOW = new Date('2026-11-03T12:00:00.000Z')

describe('automation runs', () => {
  it('keeps cron and webhook runs, and calls a running run with no live session failed', () => {
    const runs = automationRunsOf({
      'cron-live': { scheduledTaskId: 'daily-report', scheduledExecutionAt: '2026-11-03T09:00:00.000Z', automationStatus: 'running', createdAt: '2026-11-03T09:00:01.000Z' },
      'cron-died': { scheduledTaskId: 'daily-report', scheduledExecutionAt: '2026-11-02T09:00:00.000Z', automationStatus: 'running', createdAt: '2026-11-02T09:00:01.000Z' },
      'webhook-done': { isWebhookExecution: true, webhookTriggerId: 'feedback-form', webhookInvocationCount: 3, automationStatus: 'succeeded', createdAt: '2026-11-03T10:00:00.000Z' },
      'chat': { name: 'Plan the launch', createdAt: '2026-11-03T11:00:00.000Z' },
    }, ['cron-live'], NOW)

    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'cron-live', status: 'running' }),
      expect.objectContaining({ sessionId: 'cron-died', status: 'failed' }),
      expect.objectContaining({ sessionId: 'webhook-done', status: 'succeeded', webhookTriggerId: 'feedback-form', webhookInvocationCount: 3 }),
    ]))
    expect(runs).toHaveLength(3)
  })

  it('keeps the latest 30 runs of a cron and the webhook runs of the last 30 days', () => {
    const metadata = Object.fromEntries([
      ...Array.from({ length: 40 }, (_, day) => {
        const at = new Date(NOW.getTime() - (day + 1) * 86_400_000).toISOString()
        return [`cron-${day}`, { scheduledTaskId: 'daily-report', scheduledExecutionAt: at, automationStatus: 'succeeded' as const, createdAt: at }]
      }),
      ['webhook-old', { isWebhookExecution: true, webhookTriggerId: 'feedback-form', createdAt: '2026-09-01T10:00:00.000Z' }],
    ])

    const runs = automationRunsOf(metadata, [], NOW)

    expect(runs.filter((run) => run.scheduledTaskId)).toHaveLength(30)
    expect(runs.map((run) => run.sessionId)).toContain('cron-0')
    expect(runs.map((run) => run.sessionId)).not.toContain('cron-39')
    expect(runs.map((run) => run.sessionId)).not.toContain('webhook-old')
  })

  it('turns runs back into the metadata the chart builders read', () => {
    expect(automationRunsAsMetadata([
      { sessionId: 'webhook-done', createdAt: '2026-11-03T10:00:00.000Z', status: 'succeeded', webhookTriggerId: 'feedback-form', webhookInvocationCount: 3 },
      { sessionId: 'cron-old', scheduledTaskId: 'daily-report', scheduledExecutionAt: '2026-11-02T09:00:00.000Z' },
    ])).toEqual({
      'webhook-done': { createdAt: '2026-11-03T10:00:00.000Z', automationStatus: 'succeeded', isWebhookExecution: true, webhookTriggerId: 'feedback-form', webhookInvocationCount: 3 },
      'cron-old': { scheduledTaskId: 'daily-report', scheduledExecutionAt: '2026-11-02T09:00:00.000Z' },
    })
  })
})
