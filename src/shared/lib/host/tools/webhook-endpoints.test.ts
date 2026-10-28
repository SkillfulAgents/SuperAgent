import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HostToolName, HostToolRequest, HostToolResult } from '@shared/lib/agent-actor/host-port'
import { describeWebhookRelayUnavailable } from '@shared/lib/webhook-relay/errors'
import type { WebhookRelayUnavailableReason } from '@shared/lib/webhook-relay/types'

type MockFn = (...args: any[]) => any
const mockCreateWebhookTrigger = vi.fn<MockFn>(() => Promise.resolve('trigger_new_id'))
const mockGetWebhookTrigger = vi.fn<MockFn>(() => Promise.resolve(null))
const mockUpdateWebhookTriggerName = vi.fn<MockFn>(() => Promise.resolve())
const mockResolvePlatformMemberForCandidates = vi.fn<MockFn>(() => null)
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  createWebhookTrigger: (...args: unknown[]) => mockCreateWebhookTrigger(...args),
  getWebhookTrigger: (...args: unknown[]) => mockGetWebhookTrigger(...args),
  updateWebhookTriggerName: (...args: unknown[]) => mockUpdateWebhookTriggerName(...args),
  resolvePlatformMemberForCandidates: (...args: unknown[]) => mockResolvePlatformMemberForCandidates(...args),
}))

const mockCreateRelayEndpoint = vi.fn<MockFn>()
const mockUpdateRelayEndpoint = vi.fn<MockFn>(() => Promise.resolve({}))
const mockDisableRelayEndpoint = vi.fn<MockFn>(() => Promise.resolve())
const mockListRelayEndpointEvents = vi.fn<MockFn>(() => Promise.resolve({ filterExp: null, events: [] }))
const mockTestRelayEndpointFilter = vi.fn<MockFn>()
// Receiving by default: the webhook tools gate on the relay's availability
// (NOT on Composio mode — custom endpoints must work with a personal Composio
// key).
const mockRelayUnavailableReason = vi.fn(() => null as WebhookRelayUnavailableReason | null)
vi.mock('@shared/lib/webhook-relay', () => ({
  webhooksUnavailableMessage: (what: string) => {
    const reason = mockRelayUnavailableReason()
    return reason ? describeWebhookRelayUnavailable(what, reason) : null
  },
  getWebhookRelay: () => ({
    createEndpoint: (...args: unknown[]) => mockCreateRelayEndpoint(...args),
    updateEndpoint: (...args: unknown[]) => mockUpdateRelayEndpoint(...args),
    disableEndpoint: (...args: unknown[]) => mockDisableRelayEndpoint(...args),
    listEndpointEvents: (...args: unknown[]) => mockListRelayEndpointEvents(...args),
    testEndpointFilter: (...args: unknown[]) => mockTestRelayEndpointFilter(...args),
  }),
}))

// Read by the real attribution module and the session-member fallback.
const mockGetPlatformAccessToken = vi.fn(() => 'opaque_token' as string | null)
const mockGetStoredPlatformMemberId = vi.fn(() => null as string | null)
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getStoredPlatformMemberId: () => mockGetStoredPlatformMemberId(),
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

// Custom endpoints never consult Composio mode; mocked so a test can turn
// platform Composio off and show the tools do not care.
const mockIsPlatformComposioActive = vi.fn(() => true)
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => mockIsPlatformComposioActive(),
}))

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

// The session owner the tools attribute to: the agent's session metadata.
const mockSessionMetadata = vi.fn<MockFn>(() => Promise.resolve(null))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (agentSlug: string) => ({
      sessions: { metadata: (sessionId: string) => mockSessionMetadata(agentSlug, sessionId) },
    }),
  },
}))

import { globalFeed } from '@shared/lib/notifications/global-feed'
import { createWebhookEndpoint, formatWebhookEventLine, inspectWebhookEvents, updateWebhookEndpoint } from './webhook-endpoints'

const AGENT_SLUG = 'test-agent'
const SESSION_ID = 'test-session-1'
const publish = vi.spyOn(globalFeed, 'publish')

function request(toolName: HostToolName, toolUseId: string, input: Record<string, unknown>): HostToolRequest {
  return { agentSlug: AGENT_SLUG, sessionId: SESSION_ID, toolUseId, toolName, input: JSON.stringify(input) }
}

function resolvedOf(result: HostToolResult): Extract<HostToolResult, { status: 'resolved' }> {
  if (result.status !== 'resolved') throw new Error(`Expected the tool to resolve; it rejected: ${result.reason}`)
  return result
}

function reasonOf(result: HostToolResult): string {
  if (result.status !== 'rejected') throw new Error(`Expected the tool to reject; it resolved: ${result.value}`)
  return result.reason
}

beforeEach(() => {
  // Back to each mock's default implementation, so no test inherits another's.
  vi.resetAllMocks()
})

describe('create_webhook_endpoint', () => {
  const ENDPOINT = {
    id: 'whep_11111111-2222-4333-8444-555555555555',
    url: 'https://proxy.test/v1/hooks/whep_11111111-2222-4333-8444-555555555555',
    name: 'Deploy hook',
    status: 'active',
    verification: null,
    receive_count: 0,
    rejected_count: 0,
    last_received_at: null,
    created_at: '2026-07-06T00:00:00Z',
  }

  beforeEach(() => {
    mockCreateRelayEndpoint.mockResolvedValue(ENDPOINT)
  })

  it('mints on the platform, saves a kind=custom trigger row, and resolves with the URL', async () => {
    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-1', {
      name: 'Deploy hook',
      prompt: 'Summarize the deploy result',
    }))

    // Nothing resolves a member: the opaque-key placeholder, never persisted as the minter.
    expect(mockCreateRelayEndpoint).toHaveBeenCalledTimes(1)
    expect(mockCreateRelayEndpoint.mock.calls[0]).toEqual(['local', { name: 'Deploy hook' }])

    expect(mockCreateWebhookTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSlug: AGENT_SLUG,
        kind: 'custom',
        composioTriggerId: ENDPOINT.id,
        triggerType: 'CUSTOM_WEBHOOK',
        prompt: 'Summarize the deploy result',
        name: 'Deploy hook',
        createdBySessionId: SESSION_ID,
        createdByUserId: undefined,
        mintedByMemberId: undefined,
      }),
    )
    const triggerConfig = JSON.parse(mockCreateWebhookTrigger.mock.calls[0][0].triggerConfig)
    expect(triggerConfig).toEqual({ url: ENDPOINT.url, endpointId: ENDPOINT.id })

    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain(ENDPOINT.url)
    expect(value).toContain('UNVERIFIED')
    // Registration guidance: agent-does-it-first (API → browser), user
    // walkthrough only as the fallback.
    expect(value).toContain('YOURSELF')
    expect(value).toContain('browser')
    expect(value).toContain('walkthrough')

    expect(sessionEvents).toEqual([
      {
        type: 'webhook_trigger_created',
        toolUseId: 'tool-mint-1',
        triggerId: 'trigger_new_id',
        triggerType: 'CUSTOM_WEBHOOK',
        name: 'Deploy hook',
        agentSlug: AGENT_SLUG,
      },
    ])
    expect(publish).toHaveBeenCalledExactlyOnceWith({ type: 'webhook_trigger_created', triggerId: 'trigger_new_id', agentSlug: AGENT_SLUG })
  })

  it("mints as the session owner's member and records them as minter and creator", async () => {
    mockSessionMetadata.mockResolvedValue({ createdByUserId: 'user_owner' })
    mockResolvePlatformMemberForCandidates.mockReturnValue({ userId: 'user_owner', memberId: 'sub_owner' })

    resolvedOf(await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-owner', {
      name: 'Deploy hook',
      prompt: 'Handle it',
    })))

    expect(mockSessionMetadata).toHaveBeenCalledWith(AGENT_SLUG, SESSION_ID)
    expect(mockResolvePlatformMemberForCandidates).toHaveBeenCalledWith(['user_owner'])
    expect(mockCreateRelayEndpoint.mock.calls[0][0]).toBe('sub_owner')
    expect(mockCreateWebhookTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: 'user_owner', mintedByMemberId: 'sub_owner' }),
    )
  })

  it('passes a valid verification profile through to the platform', async () => {
    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-2', {
      name: 'Signed hook',
      prompt: 'Handle it',
      verification: {
        algorithm: 'hmac-sha256',
        encoding: 'hex',
        header: 'x-hub-signature-256',
        prefix: 'sha256=',
        template: '{body}',
        secret: 'shh',
      },
    }))

    expect(mockCreateRelayEndpoint.mock.calls[0][1].verification.secret).toBe('shh')
    expect(resolvedOf(result).value).not.toContain('UNVERIFIED')
  })

  it('rejects an invalid verification profile before any platform call', async () => {
    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-3', {
      name: 'Bad profile',
      prompt: 'Handle it',
      verification: { algorithm: 'rot13' },
    }))

    expect(reasonOf(result)).toContain('Invalid tool input: verification.')
    expect(mockCreateRelayEndpoint).not.toHaveBeenCalled()
  })

  it('disables the platform endpoint when the local save fails (rollback)', async () => {
    const dbError = new Error('disk full')
    mockCreateWebhookTrigger.mockRejectedValueOnce(dbError)

    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-4', {
      name: 'Doomed hook',
      prompt: 'Handle it',
    }))

    expect(reasonOf(result)).toBe('Failed to save trigger locally')
    // Disabled as the member it was minted under.
    expect(mockDisableRelayEndpoint).toHaveBeenCalledWith('local', ENDPOINT.id)
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(dbError, {
      tags: { area: 'webhook-endpoints', op: 'create-local-save' },
      extra: { endpointId: ENDPOINT.id, agentSlug: AGENT_SLUG, sessionId: SESSION_ID },
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('reports an orphaned live endpoint when the rollback fails too', async () => {
    const dbError = new Error('disk full')
    const rollbackError = new Error('relay unreachable')
    mockCreateWebhookTrigger.mockRejectedValueOnce(dbError)
    mockDisableRelayEndpoint.mockRejectedValueOnce(rollbackError)

    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-orphan', {
      name: 'Doomed hook',
      prompt: 'Handle it',
    }))

    expect(reasonOf(result)).toBe('Failed to save trigger locally')
    expect(mockCaptureException.mock.calls).toEqual([
      [dbError, expect.objectContaining({ tags: { area: 'webhook-endpoints', op: 'create-local-save' } })],
      [rollbackError, {
        tags: { area: 'webhook-endpoints', op: 'create-rollback' },
        extra: { endpointId: ENDPOINT.id, agentSlug: AGENT_SLUG, sessionId: SESSION_ID, memberId: 'local' },
      }],
    ])
  })

  it('rejects and reports when the relay fails to mint', async () => {
    const mintError = new Error('Webhook endpoints API error 503')
    mockCreateRelayEndpoint.mockRejectedValueOnce(mintError)

    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-relayfail', {
      name: 'Unlucky hook',
      prompt: 'Handle it',
    }))

    expect(reasonOf(result)).toBe('Failed to create webhook endpoint: Webhook endpoints API error 503')
    expect(mockCreateWebhookTrigger).not.toHaveBeenCalled()
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(mintError, {
      tags: { area: 'webhook-endpoints', op: 'create' },
      extra: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID, toolUseId: 'tool-mint-relayfail' },
    })
  })

  it('rejects with the reason while the relay is unavailable', async () => {
    mockRelayUnavailableReason.mockReturnValue('platform_disconnected')

    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-5', {
      name: 'No platform',
      prompt: 'Handle it',
    }))

    expect(reasonOf(result)).toBe(
      'Custom webhook endpoints are unavailable: the platform is not connected',
    )
    expect(mockCreateRelayEndpoint).not.toHaveBeenCalled()
  })

  it('mints with a personal Composio key as long as the relay is available', async () => {
    // Custom endpoints live on the platform proxy, not Composio — a user
    // who brings their own Composio key must still be able to mint.
    mockIsPlatformComposioActive.mockReturnValue(false)

    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-6', {
      name: 'Own composio key',
      prompt: 'Handle it',
    }))

    resolvedOf(result)
    expect(mockCreateRelayEndpoint).toHaveBeenCalled()
  })

  it('passes filter_exp through to the relay and confirms it in the result', async () => {
    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-7', {
      name: 'Filtered hook',
      prompt: 'Handle assigned issues',
      filter_exp: 'headers["linear-event"] == "Issue" && has(body.updatedFrom.assigneeId)',
    }))

    expect(mockCreateRelayEndpoint.mock.calls[0][1].filterExp).toBe(
      'headers["linear-event"] == "Issue" && has(body.updatedFrom.assigneeId)',
    )
    const { value } = resolvedOf(result)
    expect(value).toContain('Delivery filter active')
    expect(value).toContain('inspect_webhook_events')
  })

  it('teaches the filter loop when minting WITHOUT a filter', async () => {
    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-8', {
      name: 'Unfiltered hook',
      prompt: 'Handle it',
    }))

    expect(mockCreateRelayEndpoint.mock.calls[0][1].filterExp).toBeUndefined()
    const { value } = resolvedOf(result)
    // No filter → the result must make filtering an explicit decision
    // (compare subscription breadth vs the prompt) and point at
    // filter_exp + the dry-run tool.
    expect(value).toContain('decide whether you need one')
    expect(value).toContain('filter_exp')
    expect(value).toContain('update_webhook_endpoint')
    expect(value).toContain('test_filter_exp')
  })

  it('rejects an over-length filter_exp before any platform call', async () => {
    const result = await createWebhookEndpoint(request('create_webhook_endpoint', 'tool-mint-9', {
      name: 'Too long',
      prompt: 'Handle it',
      filter_exp: `body.a == "${'x'.repeat(2100)}"`,
    }))

    expect(reasonOf(result)).toContain('filter_exp')
    expect(mockCreateRelayEndpoint).not.toHaveBeenCalled()
  })
})

describe('update_webhook_endpoint', () => {
  const customTrigger = {
    id: 'trigger_custom_1',
    agentSlug: 'test-agent',
    kind: 'custom',
    composioTriggerId: 'whep_11111111-2222-4333-8444-555555555555',
    status: 'active',
  }

  beforeEach(() => {
    mockGetWebhookTrigger.mockResolvedValue(customTrigger)
  })

  it('attaches verification post-mint (the secret-arrives-later flow)', async () => {
    const result = await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-1', {
      trigger_id: 'trigger_custom_1',
      verification: {
        algorithm: 'hmac-sha256',
        encoding: 'base64',
        header: 'webhook-signature',
        template: '{webhook_id}.{timestamp}.{body}',
        timestamp_header: 'webhook-timestamp',
        secret: 'whsec_abc',
        secret_encoding: 'base64',
      },
    }))

    expect(mockUpdateRelayEndpoint).toHaveBeenCalledWith(
      expect.any(String),
      customTrigger.composioTriggerId,
      expect.objectContaining({ verification: expect.objectContaining({ secret: 'whsec_abc' }) }),
    )
    const { value } = resolvedOf(result)
    expect(value).toContain('signature-verified')
    // The secret never comes back in the text the agent reads.
    expect(value).not.toContain('whsec_abc')
  })

  // SUP-765: the endpoint is scoped to whoever minted it, so a PATCH under
  // the session creator's member 404s at the proxy.
  it('patches as the recorded minting member, not the trigger creator', async () => {
    mockGetWebhookTrigger.mockResolvedValue({ ...customTrigger, mintedByMemberId: 'sub_minted' })
    mockResolvePlatformMemberForCandidates.mockReturnValue({ userId: 'u1', memberId: 'sub_creator' })

    resolvedOf(await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-minted', {
      trigger_id: 'trigger_custom_1',
      name: 'renamed',
    })))

    expect(mockUpdateRelayEndpoint).toHaveBeenCalledWith(
      'sub_minted',
      customTrigger.composioTriggerId,
      { name: 'renamed' },
    )
    // The local row follows, so the list and the UI don't show a stale name.
    expect(mockUpdateWebhookTriggerName).toHaveBeenCalledWith('trigger_custom_1', 'renamed')
  })

  it('falls back to the creator member for rows minted before the column existed', async () => {
    mockResolvePlatformMemberForCandidates.mockReturnValue({ userId: 'u1', memberId: 'sub_creator' })

    resolvedOf(await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-precolumn', {
      trigger_id: 'trigger_custom_1',
      name: 'renamed',
    })))

    expect(mockUpdateRelayEndpoint).toHaveBeenCalledWith(
      'sub_creator',
      customTrigger.composioTriggerId,
      { name: 'renamed' },
    )
  })

  it('rejects for a non-custom trigger', async () => {
    mockGetWebhookTrigger.mockResolvedValue({ ...customTrigger, kind: 'composio' })

    const result = await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-2', {
      trigger_id: 'trigger_custom_1',
      name: 'renamed',
    }))

    expect(reasonOf(result)).toContain('No custom webhook endpoint')
    expect(mockUpdateRelayEndpoint).not.toHaveBeenCalled()
  })

  it('rejects an unknown trigger id', async () => {
    mockGetWebhookTrigger.mockResolvedValue(null)

    const result = await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-3', {
      trigger_id: 'nope',
      name: 'renamed',
    }))

    expect(reasonOf(result)).toBe('No custom webhook endpoint found for trigger nope')
    expect(mockUpdateRelayEndpoint).not.toHaveBeenCalled()
  })

  it('rejects a cancelled endpoint and a call that changes nothing', async () => {
    mockGetWebhookTrigger.mockResolvedValue({ ...customTrigger, status: 'cancelled' })
    const cancelled = await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-cancelled', {
      trigger_id: 'trigger_custom_1',
      name: 'renamed',
    }))
    expect(reasonOf(cancelled)).toContain('is cancelled; create a new endpoint instead')

    mockGetWebhookTrigger.mockResolvedValue(customTrigger)
    const empty = await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-empty', {
      trigger_id: 'trigger_custom_1',
    }))
    expect(reasonOf(empty)).toBe('Nothing to update: pass name, verification, and/or filter_exp')

    expect(mockUpdateRelayEndpoint).not.toHaveBeenCalled()
  })

  it('sets a filter_exp and explains the filtered-events semantics', async () => {
    const result = await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-4', {
      trigger_id: 'trigger_custom_1',
      filter_exp: 'body.action == "update"',
    }))

    expect(mockUpdateRelayEndpoint).toHaveBeenCalledWith(
      expect.any(String),
      customTrigger.composioTriggerId,
      { filterExp: 'body.action == "update"' },
    )
    const { value } = resolvedOf(result)
    expect(value).toContain('filter set')
    expect(value).toContain('fail open')
  })

  it('clears the filter with filter_exp: null', async () => {
    const result = await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-5', {
      trigger_id: 'trigger_custom_1',
      filter_exp: null,
    }))

    expect(mockUpdateRelayEndpoint).toHaveBeenCalledWith(
      expect.any(String),
      customTrigger.composioTriggerId,
      { filterExp: null },
    )
    expect(resolvedOf(result).value).toContain('filter removed')
  })

  it('rejects and reports when the relay update fails', async () => {
    const relayError = new Error('Webhook endpoints API error 404')
    mockUpdateRelayEndpoint.mockRejectedValueOnce(relayError)

    const result = await updateWebhookEndpoint(request('update_webhook_endpoint', 'tool-upd-relayfail', {
      trigger_id: 'trigger_custom_1',
      name: 'renamed',
    }))

    expect(reasonOf(result)).toBe('Failed to update webhook endpoint: Webhook endpoints API error 404')
    expect(mockUpdateWebhookTriggerName).not.toHaveBeenCalled()
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(relayError, {
      tags: { area: 'webhook-endpoints', op: 'update' },
      extra: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID, toolUseId: 'tool-upd-relayfail' },
    })
  })
})

describe('inspect_webhook_events', () => {
  const customTrigger = {
    id: 'trigger_custom_1',
    agentSlug: 'test-agent',
    kind: 'custom',
    composioTriggerId: 'whep_11111111-2222-4333-8444-555555555555',
    status: 'active',
  }

  beforeEach(() => {
    mockGetWebhookTrigger.mockResolvedValue(customTrigger)
    mockListRelayEndpointEvents.mockResolvedValue({ filterExp: null, events: [] })
  })

  // SUP-765: same scoping as update/teardown — a read under the creator's
  // member 404s for anything minted by someone else.
  it('reads as the recorded minting member, not the trigger creator', async () => {
    mockGetWebhookTrigger.mockResolvedValue({ ...customTrigger, mintedByMemberId: 'sub_minted' })
    mockResolvePlatformMemberForCandidates.mockReturnValue({ userId: 'u1', memberId: 'sub_creator' })

    resolvedOf(await inspectWebhookEvents(request('inspect_webhook_events', 'tool-insp-minted', {
      trigger_id: 'trigger_custom_1',
    })))

    expect(mockListRelayEndpointEvents).toHaveBeenCalledWith(
      'sub_minted',
      customTrigger.composioTriggerId,
      undefined,
    )
  })

  it('dry-runs a filter as the recorded minting member too', async () => {
    mockGetWebhookTrigger.mockResolvedValue({ ...customTrigger, mintedByMemberId: 'sub_minted' })
    mockTestRelayEndpointFilter.mockResolvedValue({
      filter_exp: 'body.action == "update"',
      evaluated: 0,
      summary: { passed: 0, filtered: 0, error: 0, skipped: 0 },
      results: [],
    })

    resolvedOf(await inspectWebhookEvents(request('inspect_webhook_events', 'tool-insp-minted-filter', {
      trigger_id: 'trigger_custom_1',
      test_filter_exp: 'body.action == "update"',
    })))

    expect(mockTestRelayEndpointFilter).toHaveBeenCalledWith(
      'sub_minted',
      customTrigger.composioTriggerId,
      'body.action == "update"',
      undefined,
    )
  })

  it('lists recent deliveries with filter verdicts and body previews', async () => {
    mockListRelayEndpointEvents.mockResolvedValue({
      filterExp: 'body.action == "update"',
      events: [
        {
          id: 'whe_1',
          created_at: '2026-07-07T20:45:19Z',
          status: 'consumed',
          kind: 'event',
          verified: true,
          filter: { outcome: 'passed' },
          method: 'POST',
          content_type: 'application/json',
          body: '{"action":"update"}',
        },
        {
          id: 'whe_2',
          created_at: '2026-07-07T20:44:00Z',
          status: 'filtered',
          kind: 'event',
          verified: true,
          filter: { outcome: 'filtered' },
          method: 'POST',
          content_type: 'application/json',
          body: `{"action":"create","pad":"${'x'.repeat(500)}"}`,
        },
        {
          id: 'whe_3',
          created_at: '2026-07-07T20:43:00Z',
          status: 'pending',
          kind: 'event',
          verified: false,
          filter: { outcome: 'error', error: 'No such key: parent' },
          method: 'POST',
          content_type: 'application/json',
          body: '{"other":1}',
        },
      ],
    })

    const result = await inspectWebhookEvents(request('inspect_webhook_events', 'tool-insp-1', {
      trigger_id: 'trigger_custom_1',
    }))

    expect(mockListRelayEndpointEvents).toHaveBeenCalledWith(
      expect.any(String),
      customTrigger.composioTriggerId,
      undefined,
    )
    const { value } = resolvedOf(result)
    expect(value).toContain('body.action == "update"')
    expect(value).toContain('whe_1')
    expect(value).toContain('filter: passed')
    expect(value).toContain('filter: filtered')
    expect(value).toContain('No such key: parent')
    // Body previews are capped so 50 events can't crowd the context.
    expect(value.length).toBeLessThan(2000)
  })

  it('reports when no deliveries exist yet', async () => {
    const result = await inspectWebhookEvents(request('inspect_webhook_events', 'tool-insp-2', {
      trigger_id: 'trigger_custom_1',
    }))

    expect(resolvedOf(result).value).toContain('No deliveries recorded yet')
  })

  it('dry-runs a candidate filter and summarizes the verdicts', async () => {
    mockTestRelayEndpointFilter.mockResolvedValue({
      filter_exp: 'body.action == "update"',
      evaluated: 3,
      summary: { passed: 1, filtered: 1, error: 1, skipped: 0 },
      results: [
        { event_id: 'whe_1', created_at: '2026-07-07T20:45:19Z', stored_status: 'consumed', outcome: 'passed' },
        { event_id: 'whe_2', created_at: '2026-07-07T20:44:00Z', stored_status: 'filtered', outcome: 'filtered' },
        { event_id: 'whe_3', created_at: '2026-07-07T20:43:00Z', stored_status: 'pending', outcome: 'error', error: 'No such key: action' },
      ],
    })

    const result = await inspectWebhookEvents(request('inspect_webhook_events', 'tool-insp-3', {
      trigger_id: 'trigger_custom_1',
      test_filter_exp: 'body.action == "update"',
      limit: 10,
    }))

    expect(mockTestRelayEndpointFilter).toHaveBeenCalledWith(
      expect.any(String),
      customTrigger.composioTriggerId,
      'body.action == "update"',
      10,
    )
    expect(mockListRelayEndpointEvents).not.toHaveBeenCalled()
    const { value } = resolvedOf(result)
    expect(value).toContain('1 would pass')
    expect(value).toContain('No such key: action')
    expect(value).toContain('Nothing was changed')
    expect(value).toContain('update_webhook_endpoint')
  })

  it('surfaces the platform 400 (CEL parser message) for an invalid candidate', async () => {
    const celError = new Error('Webhook endpoints API error 400: Invalid filter expression: invalid CEL expression: Unexpected token: EOF')
    mockTestRelayEndpointFilter.mockRejectedValue(celError)

    const result = await inspectWebhookEvents(request('inspect_webhook_events', 'tool-insp-4', {
      trigger_id: 'trigger_custom_1',
      test_filter_exp: 'has(body.x) &&',
    }))

    expect(reasonOf(result)).toContain('Unexpected token')
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(celError, {
      tags: { area: 'webhook-endpoints', op: 'inspect' },
      extra: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID, toolUseId: 'tool-insp-4' },
    })
  })

  it('rejects non-custom triggers, and everything while the relay is unavailable', async () => {
    mockGetWebhookTrigger.mockResolvedValue({ ...customTrigger, kind: 'composio' })
    const nonCustom = await inspectWebhookEvents(request('inspect_webhook_events', 'tool-insp-5', {
      trigger_id: 'trigger_custom_1',
    }))
    expect(reasonOf(nonCustom)).toContain('No custom webhook endpoint')
    expect(mockListRelayEndpointEvents).not.toHaveBeenCalled()

    mockRelayUnavailableReason.mockReturnValue('platform_disconnected')
    const unavailable = await inspectWebhookEvents(request('inspect_webhook_events', 'tool-insp-6', {
      trigger_id: 'trigger_custom_1',
    }))
    expect(reasonOf(unavailable)).toContain('platform')
  })
})

describe('formatWebhookEventLine', () => {
  it('marks a handshake, and an event as verified or not', () => {
    const base = { id: 'whe_1', created_at: '2026-07-07T20:45:19Z', status: 'consumed', method: 'POST', content_type: 'application/json', body: '{}' }

    expect(formatWebhookEventLine({ ...base, kind: 'handshake' })).toBe(
      '- whe_1 · 2026-07-07T20:45:19Z · consumed · handshake\n  POST application/json — {}',
    )
    expect(formatWebhookEventLine({ ...base, kind: 'event', verified: true })).toContain('consumed · verified\n')
    expect(formatWebhookEventLine({ ...base, kind: 'event', verified: false })).toContain('consumed · unverified\n')
  })

  it('caps the body preview, and marks a body the relay already truncated', () => {
    const base = { id: 'whe_2', created_at: '2026-07-07T20:44:00Z', status: 'pending', kind: 'event', verified: true }

    const long = formatWebhookEventLine({ ...base, body: 'x'.repeat(500) })
    expect(long.endsWith(`— ${'x'.repeat(200)}…`)).toBe(true)

    expect(formatWebhookEventLine({ ...base, body: 'short', body_truncated: true }).endsWith('— short…')).toBe(true)
    // No method or content type recorded: POST and an empty type.
    expect(formatWebhookEventLine({ ...base, body: null })).toContain('\n  POST  — (empty body)')
  })
})
