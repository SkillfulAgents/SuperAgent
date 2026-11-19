/**
 * The body of a decision on a computer-use request
 * (`POST /api/agents/:id/sessions/:sessionId/computer-use`): an approval
 * with what it grants, or a decline.
 *
 * Only `toolUseId` is required. A field of the wrong kind reads as absent,
 * as the route always treated it: an approval that carries a grant the
 * server does not know grants nothing beyond this call.
 */
import { z } from 'zod'

/** A value of the wrong kind is dropped, not refused. */
const lenient = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined)

export const computerUseDecisionSchema = z.object({
  toolUseId: z.string().min(1),
  method: lenient(z.string().min(1)),
  params: lenient(z.record(z.string(), z.unknown())),
  /** What the call needs. `use_any_application` is only ever granted, never asked for. */
  permissionLevel: lenient(z.enum(['list_apps_windows', 'use_application', 'use_host_shell'])),
  appName: lenient(z.string().min(1)),
  grantType: lenient(z.enum(['once', 'timed', 'always'])),
  /** Grant every app (`use_any_application`) rather than what this call needs. */
  grantAnyApp: lenient(z.literal(true)),
  decline: lenient(z.boolean()),
  declineReason: lenient(z.string()),
})

export type ComputerUseDecision = z.infer<typeof computerUseDecisionSchema>
