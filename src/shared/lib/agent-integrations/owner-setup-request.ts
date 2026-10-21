import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { captureException } from '@shared/lib/error-reporting'
import { formatProviderName } from './presentation'
import { IntegrationSetupError } from './setup-types'
import { ownerSetupPrefillSchema } from './owner-setup-schema'
import type { AgentIntegrationRecord } from './types'

/** The agent's add_agent_integration call, for a provider only its owner may set up. */
export const ownerSetupRequestInputSchema = z.object({
  provider: z.string().min(1),
  name: z.string().optional(),
  reason: z.string().trim().transform(reason => reason.slice(0, 500)).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  toolUseId: z.string({ error: 'toolUseId is required to ask the owner' }).min(1, 'toolUseId is required to ask the owner'),
  sessionId: z.string({ error: 'sessionId is required to ask the owner' }).min(1, 'sessionId is required to ask the owner'),
})

/**
 * Park the agent's call on an owner setup card in its session. The container
 * waits on the same tool-use id; the card is answered when an integration of
 * the provider connects (`answerOwnerSetupRequests`) or declined from the card.
 */
export async function requestOwnerSetup(agentSlug: string, input: z.infer<typeof ownerSetupRequestInputSchema>): Promise<boolean> {
  const config = input.config ?? {}
  const parsed = ownerSetupPrefillSchema.safeParse({ name: input.name, localPart: config.localPart, organization: config.organization })
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    throw new IntegrationSetupError(`Invalid ${issue?.path.join('.') || 'setup suggestion'}: ${issue?.message ?? 'unexpected value'}`)
  }
  // Only the suggestions given: the payload's prefill is a record of strings.
  const prefill = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined))
  const registered = await agentRegistry.get(agentSlug).inputs.register({
    id: input.toolUseId,
    kind: 'integration_setup',
    scope: { sessionId: input.sessionId },
    blocking: true,
    payload: {
      provider: input.provider,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(Object.keys(prefill).length ? { prefill } : {}),
    },
  })
  return registered !== null
}

/**
 * An integration connected: every open ask of its agent for that provider
 * goes on with it. Runs on each connect, so reconnecting an account the agent
 * already had answers the ask too; that is the account it was missing.
 */
export async function answerOwnerSetupRequests(integration: AgentIntegrationRecord): Promise<void> {
  const inputs = agentRegistry.get(integration.agentSlug).inputs
  const value = `${formatProviderName(integration.provider)} is set up (integration ID: ${integration.id}). Call list_agent_integrations for its identity, instructions and tools.`
  try {
    const open = (await inputs.snapshot())
      .filter(request => request.kind === 'integration_setup' && request.payload.provider === integration.provider)
    for (const request of open) await inputs.answer(request.id, value)
  } catch (error) {
    captureException(error, { tags: { component: 'agent-integration', operation: 'answer-owner-setup' }, extra: { integrationId: integration.id } })
  }
}
