import { describe, expect, it } from 'vitest'
import type { ApiAgent } from '@shared/lib/types/api'
import { inboundXAgentDetailsSchema } from '@shared/lib/types/inbound-x-agent-schema'
import { buildInboundXAgentDetails } from './inbound-x-agent-service'

function agent(slug: string, name: string): ApiAgent {
  return {
    slug,
    displaySlug: `${name.toLowerCase().replaceAll(' ', '-')}-${slug}`,
    name,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'stopped',
    containerPort: null,
  }
}

describe('buildInboundXAgentDetails', () => {
  it('sorts call history newest-first and excludes self and blocked callers', () => {
    const result = buildInboundXAgentDetails({
      targetSlug: 'target',
      metadata: {
        old: { invokedByAgentSlug: 'caller-a', createdAt: '2026-08-19T10:00:00.000Z' },
        newest: { invokedByAgentSlug: 'caller-b', createdAt: '2026-08-20T10:00:00.000Z' },
        human: { createdAt: '2026-08-21T10:00:00.000Z' },
      },
      agents: [agent('target', 'Target'), agent('caller-a', 'Alpha'), agent('caller-b', 'Beta')],
      authMode: false,
      aclRows: [],
      evaluatePolicy: (caller) => caller === 'caller-b' ? 'block' : 'review',
    })

    expect(result.sessions.map((session) => session.id)).toEqual(['newest', 'old'])
    expect(result.sessions[0]).toMatchObject({ triggeredBy: { name: 'Beta' } })
    expect(result.callers).toEqual([{
      slug: 'caller-a',
      displaySlug: 'alpha-caller-a',
      name: 'Alpha',
      decision: 'review',
      canAccess: true,
    }])
  })

  it('includes running, settled, and legacy repairs without inventing caller permissions', () => {
    const result = buildInboundXAgentDetails({
      targetSlug: 'target',
      metadata: {
        legacy: { name: 'Fix widget: weather', isWidgetRepair: true, widgetRepairSlug: 'weather', createdAt: '2026-08-19T10:00:00.000Z' },
        call: { invokedByAgentSlug: 'deleted-caller', createdAt: '2026-08-20T10:00:00.000Z' },
        succeeded: { isWidgetRepair: true, widgetRepairSlug: 'weather', automationStatus: 'succeeded', createdAt: '2026-08-21T10:00:00.000Z' },
        failed: { isWidgetRepair: true, widgetRepairSlug: 'weather', automationStatus: 'failed', createdAt: '2026-08-22T10:00:00.000Z' },
        running: { isWidgetRepair: true, widgetRepairSlug: 'weather', automationStatus: 'running', createdAt: '2026-08-23T10:00:00.000Z' },
        promoted: { isWidgetRepair: true, widgetRepairSlug: 'weather', promotedToInteractive: true, createdAt: '2026-08-24T10:00:00.000Z' },
        invalidDate: { isWidgetRepair: true, createdAt: 'invalid' },
        noDate: { isWidgetRepair: true },
        human: { createdAt: '2026-08-24T10:00:00.000Z' },
        cron: { isScheduledExecution: true, createdAt: '2026-08-24T10:00:00.000Z' },
        webhook: { isWebhookExecution: true, createdAt: '2026-08-24T10:00:00.000Z' },
      },
      agents: [agent('target', 'Target')],
      authMode: false,
      aclRows: [],
    })

    // Exercise the renderer's boundary too, including the existing caller shape.
    const parsed = inboundXAgentDetailsSchema.parse(result)
    expect(parsed.sessions.map((session) => session.id)).toEqual([
      'promoted', 'running', 'failed', 'succeeded', 'call', 'legacy',
    ])
    expect(parsed.sessions.filter((session) => session.isWidgetRepair)).toHaveLength(5)
    expect(parsed.sessions.at(-1)).toEqual({
      id: 'legacy',
      createdAt: '2026-08-19T10:00:00.000Z',
      isWidgetRepair: true,
      widgetRepairSlug: 'weather',
    })
    expect(parsed.callers).toEqual([])
  })

  it('requires a caller owner with user access to the target and greys inaccessible callers', () => {
    const result = buildInboundXAgentDetails({
      targetSlug: 'target',
      metadata: {},
      agents: [
        agent('target', 'Target'),
        agent('caller-a', 'Alpha'),
        agent('caller-b', 'Beta'),
        agent('caller-c', 'Charlie'),
      ],
      authMode: true,
      viewerUserId: 'viewer',
      aclRows: [
        { agentSlug: 'target', userId: 'owner-a', role: 'user' },
        { agentSlug: 'target', userId: 'owner-b', role: 'viewer' },
        { agentSlug: 'caller-a', userId: 'owner-a', role: 'owner' },
        { agentSlug: 'caller-b', userId: 'owner-b', role: 'owner' },
        { agentSlug: 'caller-c', userId: 'owner-a', role: 'owner' },
        { agentSlug: 'caller-c', userId: 'viewer', role: 'viewer' },
      ],
      evaluatePolicy: () => 'allow',
    })

    expect(result.callers.map((caller) => [caller.slug, caller.canAccess])).toEqual([
      ['caller-a', false],
      ['caller-c', true],
    ])
  })

  it('keeps eligible caller rows accessible for an admin viewer without caller ACL rows', () => {
    const result = buildInboundXAgentDetails({
      targetSlug: 'target',
      metadata: {},
      agents: [agent('target', 'Target'), agent('caller', 'Caller')],
      authMode: true,
      viewerUserId: 'admin',
      viewerCanAccessAll: true,
      aclRows: [
        { agentSlug: 'target', userId: 'owner', role: 'user' },
        { agentSlug: 'caller', userId: 'owner', role: 'owner' },
      ],
      evaluatePolicy: () => 'review',
    })

    expect(result.callers[0].canAccess).toBe(true)
  })
})
