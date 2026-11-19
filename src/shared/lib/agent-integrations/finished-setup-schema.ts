import { z } from 'zod'
import { AGENT_INTEGRATION_PROVIDERS } from './provider-types'

export const setupProviderSchema = z.enum(AGENT_INTEGRATION_PROVIDERS)
const channelStepSchema = z.object({ type: z.literal('channel'), provider: setupProviderSchema }).strict()

/** One reminder per channel. Only the provider belongs here; credentials stay in the integration. */
export const finishedSetupSchema = z.object({
  steps: z.array(channelStepSchema).refine(
    steps => new Set(steps.map(step => step.provider)).size === steps.length,
    'A channel may only appear once',
  ),
}).strict()

export type FinishedSetup = z.infer<typeof finishedSetupSchema>
