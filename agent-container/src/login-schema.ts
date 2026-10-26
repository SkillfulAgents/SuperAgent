import { z } from 'zod'
import { LOGIN_FIELD_KINDS } from './login-form-script'

/** `@e12` or `e12`, normalized to `@e12` (the CLI's form). */
export const elementRefSchema = z
  .string()
  .trim()
  .regex(/^@?e\d{1,6}$/, 'a ref from a snapshot, such as @e12')
  .transform((ref) => (ref.startsWith('@') ? ref : `@${ref}`))

export const loginFieldRequestSchema = z.object({
  ref: elementRefSchema,
  kind: z.enum(LOGIN_FIELD_KINDS),
  label: z.string().trim().min(1).max(120),
})

export const MAX_LOGIN_FIELDS = 6

/** request_login → server: locate the mapped fields. */
export const loginPrepareRequestSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  toolUseId: z.string().min(1).max(256),
  fields: z.array(loginFieldRequestSchema).min(1).max(MAX_LOGIN_FIELDS),
  submitRef: elementRefSchema.nullable(),
}).strict()

/** host → server: the user's values, by field index. */
export const loginFillRequestSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  toolUseId: z.string().min(1).max(256),
  expectedOrigin: z.string().min(1).max(2048),
  values: z.array(z.string().max(4096)).min(1).max(MAX_LOGIN_FIELDS),
}).strict()

const fieldOutcomeSchema = z.object({
  ref: z.string(),
  kind: z.enum(LOGIN_FIELD_KINDS),
  label: z.string(),
  status: z.enum(['filled', 'changed', 'skipped', 'failed']),
  problem: z.string().optional(),
  boxes: z.number().optional(),
})

/**
 * What the page did by itself after the values went in, seen before
 * anything was clicked or pressed — so nothing was.
 */
const pageActivitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigation'), url: z.string() }),
  z.object({ kind: z.literal('request'), method: z.string(), url: z.string() }),
  z.object({ kind: z.literal('detached'), ref: z.string() }),
  z.object({ kind: z.literal('locked'), ref: z.string() }),
  z.object({ kind: z.literal('gone') }),
  z.object({ kind: z.literal('unreadable'), error: z.string() }),
])

/** What the fill did, as the request_login tool call resolves with it. Never a value. */
export const loginFillReportSchema = z.object({
  type: z.literal('filled'),
  origin: z.string(),
  outcomes: z.array(fieldOutcomeSchema),
  /** Fields that, just before the submit, held another value, had left their document, or could not be read. */
  lost: z.array(z.object({ ref: z.string(), state: z.enum(['differs', 'detached', 'unreadable']), error: z.string().optional() })),
  submitted: z.union([
    z.object({ via: z.literal('click'), ref: z.string() }),
    // The CLI refused the click (a banner covers the button); the page clicked it.
    z.object({ via: z.literal('click-in-page'), ref: z.string(), clickError: z.string() }),
    z.object({ via: z.literal('enter') }),
    // A submit event fired as the values went in (a code field that submits itself).
    z.object({ via: z.literal('page') }),
  ]).nullable(),
  /** Password or code fields the page rewrote as they were written: nothing was clicked or pressed. */
  changedSecrets: z.array(z.string()).optional(),
  pageActivity: pageActivitySchema.optional(),
  /** Why the submit did not happen, as an observation ("clicking @e7 failed: …"). */
  submitError: z.string().optional(),
  /** The submit's settle observation: digest, effect, settleMs, treeDiff, tabInfo. */
  observation: z.record(z.string(), z.unknown()).optional(),
})
export type LoginFillReport = z.infer<typeof loginFillReportSchema>

/** The user signed in on the page themselves instead. */
export const loginManualReportSchema = z.object({ type: z.literal('manual') })

export const loginResolutionSchema = z.discriminatedUnion('type', [loginFillReportSchema, loginManualReportSchema])
export type LoginResolution = z.infer<typeof loginResolutionSchema>
