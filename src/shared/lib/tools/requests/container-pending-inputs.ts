import { z } from 'zod'

/** The container's `GET /inputs/pending`: the requests its tools are parked on. */
export const containerPendingInputsSchema = z.array(z.object({
  toolUseId: z.string().min(1),
  inputType: z.string(),
  sessionId: z.string().optional(),
}))
