import { z } from 'zod'

// Routing/readiness status is deliberately insufficient for deleting files
// that a process can still write. Accept only known terminal process states.
export const dockerStoppedInspectSchema = z.object({
  State: z.object({ Running: z.literal(false), Status: z.enum(['created', 'exited', 'dead']) }),
})

export const appleStoppedInspectSchema = z.object({
  status: z.union([z.literal('stopped'), z.object({ state: z.literal('stopped') })]),
})
