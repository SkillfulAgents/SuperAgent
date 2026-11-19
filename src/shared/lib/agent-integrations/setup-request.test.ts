import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentIntegrationRecord } from './types'

const inputs = vi.hoisted(() => ({ snapshot: vi.fn(), answer: vi.fn() }))
vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: { get: () => ({ inputs }) } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
import { captureException } from '@shared/lib/error-reporting'
import { answerSetupRequests } from './setup-request'

const linear = { id: 'integration-9', agentSlug: 'agent-one', provider: 'linear' } as AgentIntegrationRecord
beforeEach(() => { vi.clearAllMocks() })

it('answers the agent\'s open asks for the provider that connected, and no other', async () => {
  inputs.snapshot.mockResolvedValue([
    { id: 'ask-linear', kind: 'integration_setup', payload: { provider: 'linear' } },
    { id: 'ask-slack', kind: 'integration_setup', payload: { provider: 'slack' } },
    { id: 'ask-account', kind: 'connected_account', payload: { toolkit: 'linear' } },
  ])

  await answerSetupRequests(linear)

  expect(inputs.answer).toHaveBeenCalledExactlyOnceWith('ask-linear', expect.stringContaining('Linear is set up (integration ID: integration-9)'))
})

it('never fails the connect it runs after', async () => {
  inputs.snapshot.mockRejectedValue(new Error('actor gone'))
  await expect(answerSetupRequests(linear)).resolves.toBeUndefined()
  expect(captureException).toHaveBeenCalledOnce()
})
