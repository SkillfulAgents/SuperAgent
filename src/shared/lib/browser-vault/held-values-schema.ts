import { z } from 'zod'
import { MAX_PARTS, partKeySchema } from './vault-schemas'

/**
 * What the host holds between the steps of one sign-in, as AppState stores it
 * (held-values.ts). The values are what the user typed, passwords included:
 * they are stored as typed for now (sealing them is a follow-up), and they
 * never go into a key, an event, a log or anything the agent sees.
 */

/** As long as a value the card or the password manager can send (loginValue). */
const MAX_HELD_VALUE = 4096
/** A username from the page, the card or the request: as long as a value. */
const MAX_USERNAME = 4096
const MAX_ORIGIN = 2048

/**
 * A fill that has taken a part: no one else fills it while the claim stands.
 * `until` is epoch ms on the claiming process's clock.
 */
const heldClaimSchema = z.object({
  id: z.uuid(),
  until: z.number().int(),
}).strict()

const heldPartSchema = z.object({
  value: z.string().min(1).max(MAX_HELD_VALUE),
  /**
   * This value's own id, new with each hold: a claim or a release names the
   * value it was decided from, so it never takes a newer one held since.
   */
  id: z.uuid(),
  claim: heldClaimSchema.nullable(),
}).strict()
export type HeldPart = z.infer<typeof heldPartSchema>

export const heldLoginRecordSchema = z.object({
  username: z.string().max(MAX_USERNAME).nullable(),
  /** Where the user typed them: they go only where a saved account's would (vaultFillsInto). */
  origin: z.string().min(1).max(MAX_ORIGIN),
  /** Add them to the owner's account once they are filled: the user checked "Save for later". */
  save: z.object({
    owner: z.string().min(1).max(256).nullable(),
    origin: z.string().min(1).max(MAX_ORIGIN),
  }).strict().nullable(),
  /** By part key ('password', 'text:…'). */
  parts: z.record(partKeySchema, heldPartSchema)
    .refine((parts) => {
      const count = Object.keys(parts).length
      return count > 0 && count <= MAX_PARTS
    }, `A held sign-in holds 1 to ${MAX_PARTS} parts`),
}).strict()
export type HeldLoginRecord = z.infer<typeof heldLoginRecordSchema>

/** The username the last step on a site went in with. */
export const signInIdentitySchema = z.object({
  username: z.string().min(1).max(MAX_USERNAME),
}).strict()
export type SignInIdentity = z.infer<typeof signInIdentitySchema>
