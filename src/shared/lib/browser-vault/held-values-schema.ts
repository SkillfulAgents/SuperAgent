import { z } from 'zod'

/** A sign-in's values held for a later step. */
export const heldLoginSchema = z.object({
  username: z.string().nullable(),
  /** By part key ('password', 'text:…'). */
  values: z.record(z.string(), z.string()),
  /** Where the user typed them: they go only where a saved account's would (vaultFillsInto). */
  origin: z.string(),
  /** Add them to the owner's account once they are filled: the user checked "Save for later". */
  save: z.object({ owner: z.string().nullable(), origin: z.string() }).nullable(),
})

export type HeldLogin = z.infer<typeof heldLoginSchema>
