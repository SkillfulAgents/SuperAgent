import { z } from 'zod'
import { LOGIN_FIELD_KINDS } from './login-form-script'

/** `@e12` or `e12`, normalized to `@e12` (the CLI's form). */
export const elementRefSchema = z
  .string()
  .trim()
  .regex(/^@?e\d{1,6}$/, 'a ref from a snapshot, such as @e12')
  .transform((ref) => (ref.startsWith('@') ? ref : `@${ref}`))

export const loginFieldRequestSchema = z.object({
  /** Absent: a field of a later step, asked now and filled when a later call maps it. */
  ref: elementRefSchema.optional(),
  kind: z.enum(LOGIN_FIELD_KINDS),
  label: z.string().trim().min(1).max(120),
})

export const MAX_LOGIN_FIELDS = 6

/**
 * The services a page can offer to sign in with ("Sign in with Google"), as
 * request_login names them. The host knows each one's site, and the user's
 * form offers the ones the page shows.
 */
export const SIGN_IN_PROVIDER_IDS = ['google', 'microsoft', 'apple', 'github', 'facebook', 'linkedin', 'x', 'slack'] as const
export type SignInProviderId = (typeof SIGN_IN_PROVIDER_IDS)[number]

/**
 * request_login → server: locate the mapped fields. Fields without a ref are
 * passed through as held; with none mapped at all, the page's main frame is
 * the site. The providers are passed through for the form.
 */
export const loginPrepareRequestSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  toolUseId: z.string().min(1).max(256),
  fields: z.array(loginFieldRequestSchema).max(MAX_LOGIN_FIELDS),
  submitRef: elementRefSchema.nullable(),
  providers: z.array(z.enum(SIGN_IN_PROVIDER_IDS)).max(SIGN_IN_PROVIDER_IDS.length).default([]),
}).strict()

/**
 * Where the values came from, as the host says when it asks for a fill:
 * the user's form, or a saved account it filled by itself. The tool tells
 * the agent which account it was, never a value.
 */
export const loginFillAccountSchema = z.object({
  /** Absent when the host does not know whose account it is (a code-only step, nothing saved). */
  username: z.string().min(1).max(320).optional(),
  site: z.string().min(1).max(253),
  source: z.enum(['user', 'vault']),
  /** The user saved the account (or added parts to it) as the form went in. */
  saved: z.boolean(),
  /** Labels of fields the user filled in for a later step: the host holds them. */
  held: z.array(z.string().max(120)).max(MAX_LOGIN_FIELDS),
}).strict()
export type LoginFillAccount = z.infer<typeof loginFillAccountSchema>

/** host → server: the user's values, by field index. */
export const loginFillRequestSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  toolUseId: z.string().min(1).max(256),
  expectedOrigin: z.string().min(1).max(2048),
  values: z.array(z.string().max(4096)).min(1).max(MAX_LOGIN_FIELDS),
  account: loginFillAccountSchema.optional(),
}).strict()

const fieldOutcomeSchema = z.object({
  ref: z.string(),
  kind: z.enum(LOGIN_FIELD_KINDS),
  label: z.string(),
  status: z.enum(['filled', 'changed', 'skipped', 'failed', 'unconfirmed']),
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
  /** The account the values came from or were saved to. */
  account: loginFillAccountSchema.optional(),
})
export type LoginFillReport = z.infer<typeof loginFillReportSchema>

/** The user signed in on the page themselves instead. */
export const loginManualReportSchema = z.object({ type: z.literal('manual') })

/** A saved account as the agent sees it: who, never a value. */
const vaultAccountViewSchema = z.object({
  username: z.string(),
  label: z.string().nullable(),
  /** Part keys it holds ('password', 'text:workspace'). */
  parts: z.array(z.string()),
  /** The account it signs in with on another site. */
  via: z.object({ site: z.string(), username: z.string(), name: z.string() }).nullable(),
  /** The site turned its saved password down since the user last entered it: using it asks the user. */
  rejected: z.boolean().optional(),
})
export type VaultAccountView = z.infer<typeof vaultAccountViewSchema>

/** The agent has saved accounts on the site: the host lists them and fills nothing. */
export const loginAccountsReportSchema = z.object({
  type: z.literal('accounts'),
  site: z.string(),
  accounts: z.array(vaultAccountViewSchema).min(1),
  /** The agent named this account but mapped no field to fill. */
  named: z.boolean().optional(),
})

/** The user signs in to the site through an account on another site (Continue with Google). */
export const loginViaReportSchema = z.object({
  type: z.literal('via'),
  site: z.string(),
  username: z.string(),
  provider: z.object({ site: z.string(), username: z.string(), name: z.string() }),
  /** Saved as an account on the site, granted to this agent. */
  saved: z.boolean(),
})

export const loginResolutionSchema = z.discriminatedUnion('type', [
  loginFillReportSchema,
  loginManualReportSchema,
  loginAccountsReportSchema,
  loginViaReportSchema,
])
export type LoginResolution = z.infer<typeof loginResolutionSchema>
