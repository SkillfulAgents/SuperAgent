import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HostToolName, HostToolRequest, HostToolResult } from '@shared/lib/agent-actor/host-port'
import { describeWebhookRelayUnavailable } from '@shared/lib/webhook-relay/errors'
import type { WebhookRelayUnavailableReason } from '@shared/lib/webhook-relay/types'

type MockFn = (...args: any[]) => any
const mockCreateWebhookTrigger = vi.fn<MockFn>(() => Promise.resolve('trigger_new_id'))
const mockListActiveWebhookTriggers = vi.fn<MockFn>(() => Promise.resolve([]))
const mockCancelWebhookTriggerWithCleanup = vi.fn<MockFn>(() => Promise.resolve(true))
const mockGetWebhookTrigger = vi.fn<MockFn>(() => Promise.resolve(null))
const mockUpdateWebhookTriggerPrompt = vi.fn<MockFn>(() => Promise.resolve(true))
const mockResolvePlatformMemberForCandidates = vi.fn<MockFn>(() => null)
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  createWebhookTrigger: (...args: unknown[]) => mockCreateWebhookTrigger(...args),
  listActiveWebhookTriggers: (...args: unknown[]) => mockListActiveWebhookTriggers(...args),
  cancelWebhookTriggerWithCleanup: (...args: unknown[]) => mockCancelWebhookTriggerWithCleanup(...args),
  getWebhookTrigger: (...args: unknown[]) => mockGetWebhookTrigger(...args),
  updateWebhookTriggerPrompt: (...args: unknown[]) => mockUpdateWebhookTriggerPrompt(...args),
  resolvePlatformMemberForCandidates: (...args: unknown[]) => mockResolvePlatformMemberForCandidates(...args),
}))

// Available by default: Composio triggers deliver their events through the relay.
const mockRelayUnavailableReason = vi.fn(() => null as WebhookRelayUnavailableReason | null)
vi.mock('@shared/lib/webhook-relay', () => ({
  webhooksUnavailableMessage: (what: string) => {
    const reason = mockRelayUnavailableReason()
    return reason ? describeWebhookRelayUnavailable(what, reason) : null
  },
}))

// Read by the real attribution module, which decides how a mint is scoped.
const mockGetPlatformAccessToken = vi.fn(() => 'opaque_token' as string | null)
const mockGetStoredPlatformMemberId = vi.fn(() => null as string | null)
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getStoredPlatformMemberId: () => mockGetStoredPlatformMemberId(),
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

const mockGetAvailableTriggers = vi.fn<MockFn>(() => Promise.resolve([]))
const mockEnableComposioTrigger = vi.fn<MockFn>(() => Promise.resolve('composio_trigger_id'))
const mockDeleteComposioTrigger = vi.fn<MockFn>(() => Promise.resolve())
vi.mock('@shared/lib/composio/triggers', () => ({
  getAvailableTriggers: (...args: unknown[]) => mockGetAvailableTriggers(...args),
  enableComposioTrigger: (...args: unknown[]) => mockEnableComposioTrigger(...args),
  deleteComposioTrigger: (...args: unknown[]) => mockDeleteComposioTrigger(...args),
}))

const mockIsPlatformComposioActive = vi.fn(() => true)
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => mockIsPlatformComposioActive(),
}))

const mockDbSelect = vi.fn<MockFn>()
vi.mock('@shared/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}))
vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id', providerConnectionId: 'provider_connection_id', providerName: 'provider_name', toolkitSlug: 'toolkit_slug' },
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
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import { cancelTrigger, getAvailableTriggersTool, listTriggers, setupTrigger, updateTrigger } from './triggers'

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

const publishedOfType = (type: string) => publish.mock.calls.map(([event]) => event).filter((event) => event.type === type)

// An org-scoped platform JWT (the mode where every proxy call must carry an
// acting member); the payload only has to decode, the signature is never checked.
function buildOrgToken(orgId: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId })).toString('base64url')
  return `${header}.${payload}.sig`
}

// The db.select() chain the connected-account lookup walks.
function mockDbSelectAccount(account: { id: string; providerConnectionId: string; providerName: string; toolkitSlug: string } | null) {
  const result = account ? [account] : []
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(result),
      }),
    }),
  })
}

beforeEach(() => {
  // Back to each mock's default implementation, so no test inherits another's.
  vi.resetAllMocks()
  mockGetAvailableTriggers.mockResolvedValue([
    { slug: 'GMAIL_NEW_EMAIL', name: 'New Email', description: 'Fires on new email', type: 'webhook' },
    { slug: 'SLACK_NEW_MESSAGE', name: 'New Message', description: 'Fires on new Slack message', type: 'webhook' },
  ])
  mockDbSelectAccount({ id: 'ca_1', providerConnectionId: 'composio_ca_1', providerName: 'composio', toolkitSlug: 'gmail' })
})

describe('setup_trigger', () => {
  it('subscribes on Composio, saves the trigger, and emits webhook_trigger_created', async () => {
    const result = await setupTrigger(request('setup_trigger', 'tool-setup-1', {
      connected_account_id: 'ca_1',
      trigger_type: 'GMAIL_NEW_EMAIL',
      prompt: 'Summarize this email',
      name: 'Email Handler',
    }))

    // The agent names the local account; Composio is asked by its own id.
    expect(mockEnableComposioTrigger).toHaveBeenCalledWith('GMAIL_NEW_EMAIL', 'composio_ca_1', undefined)
    expect(mockCreateWebhookTrigger).toHaveBeenCalledWith({
      agentSlug: AGENT_SLUG,
      composioTriggerId: 'composio_trigger_id',
      connectedAccountId: 'ca_1',
      triggerType: 'GMAIL_NEW_EMAIL',
      triggerConfig: undefined,
      prompt: 'Summarize this email',
      name: 'Email Handler',
      createdBySessionId: SESSION_ID,
      createdByUserId: undefined,
      mintedByMemberId: undefined,
      model: undefined,
      effort: undefined,
      speed: undefined,
    })

    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('Webhook trigger "Email Handler" created successfully (ID: trigger_new_id)')
    expect(sessionEvents).toEqual([
      {
        type: 'webhook_trigger_created',
        toolUseId: 'tool-setup-1',
        triggerId: 'trigger_new_id',
        triggerType: 'GMAIL_NEW_EMAIL',
        name: 'Email Handler',
        agentSlug: AGENT_SLUG,
      },
    ])
    expect(publish).toHaveBeenCalledExactlyOnceWith({ type: 'webhook_trigger_created', triggerId: 'trigger_new_id', agentSlug: AGENT_SLUG })
  })

  it('validates trigger type against available triggers', async () => {
    const result = await setupTrigger(request('setup_trigger', 'tool-setup-bad', {
      connected_account_id: 'ca_1',
      trigger_type: 'NONEXISTENT_TRIGGER',
      prompt: 'Test',
    }))

    // Rejects with a helpful error naming the triggers that do exist.
    expect(reasonOf(result)).toBe(
      'Invalid trigger type "NONEXISTENT_TRIGGER" for this account.\n\nAvailable triggers for gmail: GMAIL_NEW_EMAIL, SLACK_NEW_MESSAGE',
    )
    expect(mockGetAvailableTriggers).toHaveBeenCalledWith('gmail')
    // Nothing subscribed, nothing created.
    expect(mockEnableComposioTrigger).not.toHaveBeenCalled()
    expect(mockCreateWebhookTrigger).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects when platform Composio is not active', async () => {
    mockIsPlatformComposioActive.mockReturnValue(false)

    const result = await setupTrigger(request('setup_trigger', 'tool-setup-noplatform', {
      connected_account_id: 'ca_1',
      trigger_type: 'GMAIL_NEW_EMAIL',
      prompt: 'Test',
    }))

    expect(reasonOf(result)).toContain('only available with platform Composio')
    expect(mockEnableComposioTrigger).not.toHaveBeenCalled()
  })

  it('rejects while the relay that delivers its events is unavailable', async () => {
    mockRelayUnavailableReason.mockReturnValue('stopped')

    const result = await setupTrigger(request('setup_trigger', 'tool-setup-norelay', {
      connected_account_id: 'ca_1',
      trigger_type: 'GMAIL_NEW_EMAIL',
      prompt: 'Test',
    }))

    expect(reasonOf(result)).toBe('Webhook triggers are unavailable: the webhook relay is not running')
    expect(mockEnableComposioTrigger).not.toHaveBeenCalled()
  })

  it('rejects when connected account not found', async () => {
    mockDbSelectAccount(null)

    const result = await setupTrigger(request('setup_trigger', 'tool-setup-noaccount', {
      connected_account_id: 'ca_nonexistent',
      trigger_type: 'GMAIL_NEW_EMAIL',
      prompt: 'Test',
    }))

    expect(reasonOf(result)).toBe('Connected account ca_nonexistent not found')
    expect(mockEnableComposioTrigger).not.toHaveBeenCalled()
  })

  it('rejects when a required field is missing', async () => {
    const result = await setupTrigger(request('setup_trigger', 'tool-setup-noprompt', {
      connected_account_id: 'ca_1',
      trigger_type: 'GMAIL_NEW_EMAIL',
    }))

    expect(reasonOf(result)).toContain('Missing required fields')
    expect(mockEnableComposioTrigger).not.toHaveBeenCalled()
  })

  // SUP-765: the row must record the member the proxy actually scoped the
  // subscription to. Host tools run with no guaranteed ALS scope, so the mint
  // has to establish one itself.
  it('mints under the session member and records it when no ambient attribution is active', async () => {
    mockGetPlatformAccessToken.mockReturnValue(buildOrgToken('org_test'))
    mockGetStoredPlatformMemberId.mockReturnValue('sub_session')
    let mintKey: string | null | undefined
    mockEnableComposioTrigger.mockImplementation(async () => {
      mintKey = (await attribution.current())?.getKey() ?? null
      return 'composio_trigger_id'
    })

    resolvedOf(await setupTrigger(request('setup_trigger', 'tool-setup-minted', {
      connected_account_id: 'ca_1',
      trigger_type: 'GMAIL_NEW_EMAIL',
      prompt: 'Summarize this email',
    })))

    expect(mintKey).toBe('member:sub_session')
    expect(mockCreateWebhookTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ mintedByMemberId: 'sub_session' }),
    )
  })

  it("mints as the session owner's member and attributes the trigger to the owner", async () => {
    mockGetPlatformAccessToken.mockReturnValue(buildOrgToken('org_test'))
    mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')
    mockSessionMetadata.mockResolvedValue({ createdByUserId: 'user_owner' })
    mockResolvePlatformMemberForCandidates.mockReturnValue({ userId: 'user_owner', memberId: 'sub_owner' })
    let mintKey: string | null | undefined
    mockEnableComposioTrigger.mockImplementation(async () => {
      mintKey = (await attribution.current())?.getKey() ?? null
      return 'composio_trigger_id'
    })

    resolvedOf(await setupTrigger(request('setup_trigger', 'tool-setup-owner', {
      connected_account_id: 'ca_1',
      trigger_type: 'GMAIL_NEW_EMAIL',
      prompt: 'Summarize this email',
    })))

    expect(mockSessionMetadata).toHaveBeenCalledWith(AGENT_SLUG, SESSION_ID)
    expect(mockResolvePlatformMemberForCandidates).toHaveBeenCalledWith(['user_owner'])
    expect(mintKey).toBe('member:sub_owner')
    expect(mockCreateWebhookTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: 'user_owner', mintedByMemberId: 'sub_owner' }),
    )
  })

  it('mints under an ambient attribution when one is active, and records that member', async () => {
    mockGetPlatformAccessToken.mockReturnValue(buildOrgToken('org_test'))
    mockGetStoredPlatformMemberId.mockReturnValue('sub_session')
    let mintKey: string | null | undefined
    mockEnableComposioTrigger.mockImplementation(async () => {
      mintKey = (await attribution.current())?.getKey() ?? null
      return 'composio_trigger_id'
    })

    resolvedOf(await runWithAttribution(attribution.fromMemberId('sub_ambient'), () =>
      setupTrigger(request('setup_trigger', 'tool-setup-ambient', {
        connected_account_id: 'ca_1',
        trigger_type: 'GMAIL_NEW_EMAIL',
        prompt: 'Summarize this email',
      })),
    ))

    expect(mintKey).toBe('member:sub_ambient')
    expect(mockCreateWebhookTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ mintedByMemberId: 'sub_ambient' }),
    )
  })

  it('never mints as the opaque-key placeholder member', async () => {
    // Nothing resolves: the bearer must stay the bare token, not `token::local`.
    let mintKey: string | null | undefined
    mockEnableComposioTrigger.mockImplementation(async () => {
      mintKey = (await attribution.current())?.getKey() ?? null
      return 'composio_trigger_id'
    })

    resolvedOf(await setupTrigger(request('setup_trigger', 'tool-setup-local', {
      connected_account_id: 'ca_1',
      trigger_type: 'GMAIL_NEW_EMAIL',
      prompt: 'Summarize this email',
    })))

    expect(mintKey).toBeNull()
    expect(mockCreateWebhookTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ mintedByMemberId: undefined }),
    )
  })

  it('rolls back Composio trigger if SQLite save fails', async () => {
    mockCreateWebhookTrigger.mockRejectedValue(new Error('DB write failed'))

    const result = await setupTrigger(request('setup_trigger', 'tool-setup-dbfail', {
      connected_account_id: 'ca_1',
      trigger_type: 'GMAIL_NEW_EMAIL',
      prompt: 'Test',
    }))

    expect(mockEnableComposioTrigger).toHaveBeenCalled()
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('composio_trigger_id')

    expect(reasonOf(result)).toBe('Failed to save trigger locally')
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('cancel_trigger', () => {
  it('emits webhook_trigger_cancelled on success', async () => {
    const result = await cancelTrigger(request('cancel_trigger', 'tool-cancel-1', {
      trigger_id: 'trigger_existing',
    }))

    // Scoped to the calling agent, so it cannot cancel another agent's trigger by id.
    expect(mockCancelWebhookTriggerWithCleanup).toHaveBeenCalledWith('trigger_existing', AGENT_SLUG)

    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('has been cancelled')
    expect(sessionEvents).toEqual([
      { type: 'webhook_trigger_cancelled', toolUseId: 'tool-cancel-1', triggerId: 'trigger_existing', agentSlug: AGENT_SLUG },
    ])
    expect(publishedOfType('webhook_trigger_cancelled')).toEqual([
      { type: 'webhook_trigger_cancelled', triggerId: 'trigger_existing', agentSlug: AGENT_SLUG },
    ])
  })

  it('rejects when trigger not found or already cancelled', async () => {
    mockCancelWebhookTriggerWithCleanup.mockResolvedValue(false)

    const result = await cancelTrigger(request('cancel_trigger', 'tool-cancel-notfound', {
      trigger_id: 'trigger_gone',
    }))

    expect(reasonOf(result)).toContain('not found or already cancelled')
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects when trigger_id is missing', async () => {
    const result = await cancelTrigger(request('cancel_trigger', 'tool-cancel-noid', {}))

    expect(reasonOf(result)).toContain('Missing required field')
    expect(mockCancelWebhookTriggerWithCleanup).not.toHaveBeenCalled()
  })
})

describe('list_triggers', () => {
  it('resolves with formatted trigger list', async () => {
    mockListActiveWebhookTriggers.mockResolvedValue([
      {
        id: 't1', name: 'Email Handler', triggerType: 'GMAIL_NEW_EMAIL',
        connectedAccountId: 'ca_1', fireCount: 3, prompt: 'Summarize email',
      },
      {
        id: 't2', name: null, triggerType: 'SLACK_NEW_MESSAGE',
        connectedAccountId: 'ca_2', fireCount: 0, prompt: 'Handle slack message',
      },
    ])

    const result = await listTriggers(request('list_triggers', 'tool-list-1', {}))

    expect(mockListActiveWebhookTriggers).toHaveBeenCalledWith(AGENT_SLUG)
    // Both triggers appear in the resolved value.
    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('Email Handler')
    expect(value).toContain('GMAIL_NEW_EMAIL')
    expect(value).toContain('SLACK_NEW_MESSAGE')
    expect(sessionEvents).toBeUndefined()
  })

  it("lists a custom endpoint by its public URL instead of an account", async () => {
    mockListActiveWebhookTriggers.mockResolvedValue([
      {
        id: 't3', name: 'Deploy hook', kind: 'custom', triggerType: 'CUSTOM_WEBHOOK',
        triggerConfig: JSON.stringify({ url: 'https://proxy.test/v1/hooks/whep_1', endpointId: 'whep_1' }),
        connectedAccountId: null, fireCount: 1, prompt: 'Summarize the deploy',
      },
    ])

    const { value } = resolvedOf(await listTriggers(request('list_triggers', 'tool-list-custom', {})))

    expect(value).toContain('(custom endpoint)')
    expect(value).toContain('URL: https://proxy.test/v1/hooks/whep_1')
    expect(value).not.toContain('Account:')
  })

  it('resolves with empty message when no triggers', async () => {
    mockListActiveWebhookTriggers.mockResolvedValue([])

    const result = await listTriggers(request('list_triggers', 'tool-list-empty', {}))

    expect(resolvedOf(result).value).toContain('No active webhook triggers')
  })
})

describe('update_trigger', () => {
  it('updates the prompt in place and emits the change', async () => {
    mockGetWebhookTrigger.mockResolvedValue({
      id: 'trigger_existing',
      agentSlug: AGENT_SLUG,
      status: 'active',
      fireCount: 4,
      lastSessionId: 'previous-session',
    })

    const result = await updateTrigger(request('update_trigger', 'tool-trigger-update-1', {
      trigger_id: 'trigger_existing',
      prompt: 'Handle future emails differently',
    }))

    expect(mockUpdateWebhookTriggerPrompt).toHaveBeenCalledWith(
      'trigger_existing',
      'Handle future emails differently',
    )
    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('firing history were preserved')
    expect(sessionEvents).toEqual([
      { type: 'webhook_trigger_updated', toolUseId: 'tool-trigger-update-1', triggerId: 'trigger_existing', agentSlug: AGENT_SLUG },
    ])
    expect(publishedOfType('webhook_trigger_updated')).toEqual([
      { type: 'webhook_trigger_updated', triggerId: 'trigger_existing', agentSlug: AGENT_SLUG },
    ])
  })

  it('does not update a trigger owned by another agent', async () => {
    mockGetWebhookTrigger.mockResolvedValue({
      id: 'trigger_foreign',
      agentSlug: 'other-agent',
      status: 'active',
    })

    const result = await updateTrigger(request('update_trigger', 'tool-trigger-update-foreign', {
      trigger_id: 'trigger_foreign',
      prompt: 'Take over this trigger',
    }))

    expect(reasonOf(result)).toBe('Trigger trigger_foreign not found')
    expect(mockUpdateWebhookTriggerPrompt).not.toHaveBeenCalled()
  })

  it('rejects an empty prompt at the host validation boundary', async () => {
    const result = await updateTrigger(request('update_trigger', 'tool-trigger-update-empty', {
      trigger_id: 'trigger_existing',
      prompt: '   ',
    }))

    expect(reasonOf(result)).toContain('Invalid tool input')
    expect(mockGetWebhookTrigger).not.toHaveBeenCalled()
    expect(mockUpdateWebhookTriggerPrompt).not.toHaveBeenCalled()
  })
})

describe('get_available_triggers', () => {
  it('resolves with formatted available triggers', async () => {
    const result = await getAvailableTriggersTool(request('get_available_triggers', 'tool-avail-1', {
      connected_account_id: 'ca_1',
    }))

    expect(mockGetAvailableTriggers).toHaveBeenCalledWith('gmail')
    const { value } = resolvedOf(result)
    expect(value).toContain('GMAIL_NEW_EMAIL')
    expect(value).toContain('SLACK_NEW_MESSAGE')
    expect(value).toContain('setup_trigger')
    // Custom endpoints surfaced as complementary, not a replacement.
    expect(value).toContain('create_webhook_endpoint')
    expect(value).toContain('side by side')
  })

  it('rejects when connected account not found', async () => {
    mockDbSelectAccount(null)

    const result = await getAvailableTriggersTool(request('get_available_triggers', 'tool-avail-noaccount', {
      connected_account_id: 'ca_missing',
    }))

    expect(reasonOf(result)).toBe('Connected account ca_missing not found')
  })

  it('rejects when platform Composio is not active', async () => {
    mockIsPlatformComposioActive.mockReturnValue(false)

    const result = await getAvailableTriggersTool(request('get_available_triggers', 'tool-avail-noplatform', {
      connected_account_id: 'ca_1',
    }))

    expect(reasonOf(result)).toContain('only available with platform Composio')
    expect(mockGetAvailableTriggers).not.toHaveBeenCalled()
  })

  it('resolves with empty message when no triggers available', async () => {
    mockGetAvailableTriggers.mockResolvedValue([])

    const result = await getAvailableTriggersTool(request('get_available_triggers', 'tool-avail-empty', {
      connected_account_id: 'ca_1',
    }))

    const { value } = resolvedOf(result)
    expect(value).toContain('No webhook triggers available')
    // Dead end must redirect to the custom-endpoint path.
    expect(value).toContain('create_webhook_endpoint')
    expect(value).toContain('update_webhook_endpoint')
    // ...including the filter step for over-broad vendor webhooks.
    expect(value).toContain('filter_exp')
    expect(value).toContain('inspect_webhook_events')
  })
})
