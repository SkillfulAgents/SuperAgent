import { z } from 'zod'
import { pendingUserInputRequestSchema, userInputRequestKindSchema, userInputRequestOutcomeSchema } from '../user-input/request-schema'

/** Normalize host request notifications once, before any family sees them. */
export const integrationRequestEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_request_created'), request: pendingUserInputRequestSchema }),
  z.object({ type: z.literal('user_request_resolved'), requestId: z.string().min(1),
    kind: userInputRequestKindSchema, outcome: userInputRequestOutcomeSchema,
    scope: z.object({ agentSlug: z.string().optional(), sessionId: z.string().optional() }),
  }),
])
