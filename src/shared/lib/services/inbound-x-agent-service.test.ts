import { describe, expect, it } from 'vitest'
import type { ApiAgent } from '@shared/lib/types/api'
import { agentAccessNote, agentAccessRole, inboundXAgentDetailsSchema, memberAgentsOf } from '@shared/lib/types/inbound-x-agent-schema'
import { buildAgentMemberAgents, buildInboundXAgentDetails } from './inbound-x-agent-service'

function agent(slug: string, name: string): ApiAgent {
  return {
    avatar: { color: 'tonal-blue', shape: 'circle' } as const,
    slug,
    displaySlug: `${name.toLowerCase().replaceAll(' ', '-')}-${slug}`,
    name,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'stopped',
    containerPort: null,
  }
}

describe('buildInboundXAgentDetails', () => {
  it('sorts call history newest-first and excludes self and blocked callers', async () => {
    const result = (await buildInboundXAgentDetails({
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
    }))

    expect(result.sessions.map((session) => session.id)).toEqual(['newest', 'old'])
    expect(result.sessions[0]).toMatchObject({ triggeredBy: { name: 'Beta' } })
    expect(result.callers).toEqual([{
      slug: 'caller-a',
      displaySlug: 'alpha-caller-a',
      name: 'Alpha',
      decision: 'review',
      readDecision: 'review',
      avatar: { color: 'tonal-blue', shape: 'circle' },
      canAccess: true,
      canMessage: true,
    }])
  })

  it('reports what each agent may read, so its access reads as a role', async () => {
    const result = await buildInboundXAgentDetails({
      targetSlug: 'target',
      metadata: {},
      agents: [agent('target', 'Target'), agent('sender', 'Sender'), agent('reader', 'Reader'), agent('asker', 'Asker'), agent('walled', 'Walled'), agent('mute', 'Mute')],
      authMode: false,
      aclRows: [],
      evaluatePolicy: (caller, operation) => {
        if (caller === 'sender') return operation === 'invoke' ? 'allow' : 'review'
        if (caller === 'reader') return operation === 'read' ? 'allow' : 'review'
        if (caller === 'walled') return operation === 'read' ? 'block' : 'allow'
        if (caller === 'mute') return operation === 'read' ? 'allow' : 'block'
        return 'review'
      },
    })

    expect(result.callers.map((caller) => [caller.slug, agentAccessRole(caller)])).toEqual([
      ['asker', null],
      ['mute', 'viewer'],
      ['reader', 'viewer'],
      ['sender', 'user'],
      ['walled', 'user'],
    ])
  })

  it('lists agents with a stored block either way, with the blocks to lift', async () => {
    const result = await buildInboundXAgentDetails({
      targetSlug: 'target',
      metadata: {},
      agents: [agent('target', 'Target'), agent('inbound', 'Inbound'), agent('outbound', 'Outbound'), agent('free', 'Free')],
      authMode: false,
      aclRows: [],
      blockRows: [
        { caller: 'inbound', target: 'target', operation: 'invoke' },
        { caller: 'target', target: 'outbound', operation: 'read' },
      ],
      evaluatePolicy: (caller, operation) => (caller === 'inbound' && operation === 'invoke' ? 'block' : 'review'),
    })

    // Each carries what it may still do here, so lifting the block can take that away first.
    expect(inboundXAgentDetailsSchema.parse(result).blocked?.map(({ slug, decision, readDecision, blocks }) => [slug, decision, readDecision, blocks])).toEqual([
      ['inbound', 'block', 'review', [{ callerSlug: 'inbound', operation: 'invoke' }]],
      ['outbound', 'review', 'review', [{ callerSlug: 'target', operation: 'read' }]],
    ])
    expect(result.callers.map((caller) => caller.slug)).toEqual(['free', 'outbound'])
  })

  it('includes running, settled, and legacy repairs without inventing caller permissions', async () => {
    const result = (await buildInboundXAgentDetails({
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
      evaluatePolicy: () => 'review',
    }))

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

  it('lists a caller whose owner has Viewer here as a reader only, and greys inaccessible callers', async () => {
    const result = (await buildInboundXAgentDetails({
      targetSlug: 'target',
      metadata: {},
      agents: [
        agent('target', 'Target'),
        agent('caller-a', 'Alpha'),
        agent('caller-b', 'Beta'),
        agent('caller-c', 'Charlie'),
        agent('caller-d', 'Delta'),
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
        // Two owners: one is a Viewer here, the other a User, so Delta may message.
        { agentSlug: 'caller-d', userId: 'owner-b', role: 'owner' },
        { agentSlug: 'caller-d', userId: 'owner-a', role: 'owner' },
      ],
      evaluatePolicy: () => 'allow',
    }))

    // Beta's owner is a Viewer here: the routes let Beta read but not message, so it is a Viewer, not dropped.
    expect(result.callers.map((caller) => [caller.slug, agentAccessRole(caller), caller.canAccess])).toEqual([
      ['caller-a', 'user', false],
      ['caller-b', 'viewer', false],
      ['caller-c', 'user', true],
      ['caller-d', 'user', false],
    ])
  })

  it('keeps eligible caller rows accessible for an admin viewer without caller ACL rows', async () => {
    const result = (await buildInboundXAgentDetails({
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
    }))

    expect(result.callers[0].canAccess).toBe(true)
  })
})

describe('memberAgentsOf', () => {
  it('lists the agents with a role, leaving out any with a block between the two', () => {
    const caller = (slug: string, decision: 'allow' | 'review', readDecision: 'allow' | 'review') =>
      ({ slug, displaySlug: slug, name: slug, decision, readDecision, avatar: null, canAccess: true })
    const members = memberAgentsOf({
      callers: [caller('user', 'allow', 'allow'), caller('viewer', 'review', 'allow'), caller('asks', 'review', 'review'), caller('blocked', 'allow', 'allow')],
      blocked: [{ ...caller('blocked', 'allow', 'allow'), blocks: [{ callerSlug: 'target', operation: 'invoke' }] }],
    })
    expect(members.map(({ slug, role }) => [slug, role])).toEqual([['user', 'user'], ['viewer', 'viewer']])
  })
})

describe('agentAccessNote', () => {
  it('notes a User whose reading asks first or is blocked, and a block that covers less than all four', () => {
    expect([
      agentAccessNote({ role: 'user', readDecision: 'review' }),
      agentAccessNote({ role: 'user', readDecision: 'block' }),
      agentAccessNote({ role: 'user', readDecision: 'allow' }),
      agentAccessNote({ role: 'viewer', readDecision: 'allow' }),
      agentAccessNote({ role: 'blocked', blocks: [{ callerSlug: 'a', operation: 'invoke' }, { callerSlug: 'a', operation: 'read' }] }),
      agentAccessNote({ role: 'blocked', blocks: (['a', 'b'] as const).flatMap((callerSlug) => [{ callerSlug, operation: 'invoke' as const }, { callerSlug, operation: 'read' as const }]) }),
    ]).toEqual(['Reading asks first', 'Reading blocked', null, null, 'Partly blocked', 'Can’t read or message each other'])
  })
})

describe('buildAgentMemberAgents', () => {
  it('counts a member agent that only another of the agent\'s people uses, as it would a person', async () => {
    // Work is shared by Alice and Bob. Scout is Alice's alone and a User of Work. Bob's stacks list Work only.
    const byAgent = await buildAgentMemberAgents(['work'], {
      agents: [agent('work', 'Work'), agent('scout', 'Scout')],
      authMode: true,
      aclRows: [
        { agentSlug: 'work', userId: 'alice', role: 'owner' },
        { agentSlug: 'work', userId: 'bob', role: 'user' },
        { agentSlug: 'scout', userId: 'alice', role: 'owner' },
      ],
      blockRows: [],
      evaluatePolicy: () => 'allow',
    })
    expect(byAgent.work?.map(({ slug, role }) => [slug, role])).toEqual([['scout', 'user']])
  })
})
