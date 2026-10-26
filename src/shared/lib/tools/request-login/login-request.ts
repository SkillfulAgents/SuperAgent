import { z } from 'zod'

/** Mirrors agent-container/src/login-form-script.ts. */
export const LOGIN_FIELD_KINDS = ['username', 'password', 'otp', 'text'] as const
export type LoginFieldKind = (typeof LOGIN_FIELD_KINDS)[number]

export const MAX_LOGIN_FIELDS = 6

/** A field as the agent mapped it: model input, so every part is optional. */
export interface LoginFieldInput {
  ref?: string
  kind?: string
  label?: string
}

/** A field as the request card shows it before the browser has located it. */
export interface LoginFieldSummary {
  kind: LoginFieldKind
  label: string
}

const loginFieldKindSchema = z.enum(LOGIN_FIELD_KINDS)

/** Model input → the fields worth drawing; malformed entries are dropped. */
export function summarizeLoginFields(fields: unknown): LoginFieldSummary[] {
  if (!Array.isArray(fields)) return []
  return fields.flatMap((field) => {
    if (!field || typeof field !== 'object') return []
    const { kind, label } = field as LoginFieldInput
    const parsedKind = loginFieldKindSchema.safeParse(kind)
    if (!parsedKind.success) return []
    return [{ kind: parsedKind.data, label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : parsedKind.data }]
  }).slice(0, MAX_LOGIN_FIELDS)
}

/**
 * What the browser found when it located the fields: the origin of the frame
 * holding them (the only place the values are ever written) and how each
 * field takes input. Read from the container once, then kept on the request.
 */
const webOrigin = z.string().regex(/^https?:\/\/[^/]+$/)

export const loginContextSchema = z.object({
  origin: webOrigin,
  url: z.string(),
  /** The page's main-frame origin: differs when the form sits in a frame of another site. */
  topOrigin: webOrigin,
  submit: z.boolean(),
  fields: z.array(z.object({
    kind: loginFieldKindSchema,
    label: z.string().max(120),
    inputType: z.string().max(32),
    inputMode: z.string().max(32),
    autocomplete: z.string().max(200),
    maxLength: z.number().int(),
  })).max(MAX_LOGIN_FIELDS),
  /**
   * Fields the agent mapped without a ref: a later step's, which the user
   * enters now and the host fills when a later call maps them.
   */
  held: z.array(z.object({
    kind: loginFieldKindSchema,
    label: z.string().max(120),
  })).max(MAX_LOGIN_FIELDS).default([]),
  /** The page's buttons for signing in with another service ("Sign in with Google"), as the agent listed them: provider ids. */
  providers: z.array(z.string().max(32)).max(16).default([]),
})
export type LoginContext = z.infer<typeof loginContextSchema>
export type LoginContextField = LoginContext['fields'][number]

/** The container's answer to a fill: counts and observations, never values. */
export const loginFillResultSchema = z.object({
  success: z.literal(true),
  filled: z.number().int(),
  failed: z.number().int(),
  /** Each located field's outcome, in order: whether its value went into the page. */
  outcomes: z.array(z.enum(['filled', 'changed', 'skipped', 'failed', 'unconfirmed'])).max(MAX_LOGIN_FIELDS).optional(),
  submitted: z.boolean(),
  problems: z.array(z.string()),
  /** The account the form saved to the user's vault. */
  saved: z.object({ username: z.string(), site: z.string() }).optional(),
  /** The values went in, but the account could not be saved. */
  saveError: z.string().optional(),
})
export type LoginFillResult = z.infer<typeof loginFillResultSchema>

/** The answer to a fill when the browser had closed: what the agent's next try signs in with, if anything. */
export const loginBrowserClosedSchema = z.object({
  browserClosed: z.literal(true),
  kept: z.object({ how: z.enum(['saved', 'picked', 'vault', 'held']), username: z.string().nullable() }).optional(),
})

const loginValue = z.string().max(4096)

/**
 * The fill request the app sends: the origin it showed, one value per field
 * (empty for a field a saved account fills), and one per held field.
 */
export const fillLoginBodySchema = z.object({
  toolUseId: z.string().min(1),
  origin: z.string().min(1).max(2048),
  values: z.array(loginValue).max(MAX_LOGIN_FIELDS),
  heldValues: z.array(loginValue).max(MAX_LOGIN_FIELDS).optional(),
  /** Save the account to the user's vault and grant it to this agent. */
  save: z.boolean().optional(),
  /** Whose account it is, when the page has no username field. */
  username: z.string().trim().max(320).optional(),
  /** A saved account that fills the fields left empty (the user's own, or one this agent may use). */
  accountId: z.string().min(1).max(64).optional(),
  /** The user saw that other members of this agent can sign in with what it saves or uses. */
  sharedAgentAcknowledged: z.boolean().optional(),
}).strict()
export type FillLoginBody = z.infer<typeof fillLoginBodySchema>

/**
 * How the host left a sign-in request for the user (on the request's
 * payload): a new account, a named one to enter or correct, or a saved
 * account that lacks some of what the page asks for.
 */
export const loginVaultPayloadSchema = z.object({
  mode: z.enum(['new', 'ask', 'complete']),
  username: z.string().max(320).optional(),
  /** complete: the saved account whose parts fill the covered fields. */
  accountId: z.string().max(64).optional(),
  /** complete: indexes of the located fields the vault fills, which the form does not ask for. */
  covered: z.array(z.number().int().min(0)).max(MAX_LOGIN_FIELDS).optional(),
  /** ask: why the agent asks the user, in its words (what the page said when it turned the account down). */
  reason: z.string().max(500).optional(),
  /** ask: when an agent said the site turned the named account down; its password is not filled without the user since. */
  rejectedAt: z.string().max(40).optional(),
  /** ask: when the named account's saved password already went in during this session. */
  filledAt: z.string().max(40).optional(),
})
export type LoginVaultPayload = z.infer<typeof loginVaultPayloadSchema>

/** A saved account offered in the form: metadata only. */
const vaultOfferSchema = z.object({
  id: z.string(),
  username: z.string(),
  label: z.string().nullable(),
  parts: z.array(z.string()),
  /** The account it signs in with; `id` to sign in through it under "Or sign in with". */
  via: z.object({ id: z.string().optional(), site: z.string(), username: z.string(), name: z.string() }).nullable(),
  /** This agent may already use it. */
  granted: z.boolean(),
  /** Its saved parts go into this page (one saved on https is not filled into plain HTTP). */
  fillsHere: z.boolean().optional(),
  /** An agent said the site turned it down since its password was last entered. */
  rejected: z.boolean().optional(),
})
export type VaultOffer = z.infer<typeof vaultOfferSchema>

/** What the form offers this viewer from their vault for the request's site. */
export const loginVaultInfoSchema = z.object({
  site: z.string(),
  /** Other members can use the agent: saving or using an account here shares it with them. */
  otherMembers: z.number().int().min(0),
  /** The username the previous step on this site went in with. */
  identity: z.string().nullable(),
  /** The viewer's accounts on the site. */
  accounts: z.array(vaultOfferSchema),
  /** The viewer's accounts on sign-in providers, for "Or sign in with Google, …"; `providerId` null for another site's. */
  providerAccounts: z.array(vaultOfferSchema.extend({ site: z.string(), providerName: z.string(), providerId: z.string().nullable() })),
  /** The sign-in providers this site's form may offer: not the site's own. */
  providers: z.array(z.object({ id: z.string(), name: z.string(), site: z.string() })),
})
export type LoginVaultInfo = z.infer<typeof loginVaultInfoSchema>

/** "Or sign in with Google, …": a saved provider account, or one entered by email. */
export const loginViaBodySchema = z.object({
  toolUseId: z.string().min(1),
  origin: z.string().min(1).max(2048),
  provider: z.union([
    z.object({ accountId: z.string().min(1).max(64) }).strict(),
    z.object({ providerId: z.string().min(1).max(40), username: z.string().trim().min(1).max(320) }).strict(),
  ]),
  sharedAgentAcknowledged: z.boolean().optional(),
}).strict()

/** A saved login picked from the host's password manager, by its one-shot selection id. */
export const fillLoginCredentialBodySchema = z.object({
  toolUseId: z.string().min(1),
  credentialId: z.string().min(1),
}).strict()

export const completeLoginBodySchema = z.object({
  toolUseId: z.string().min(1),
  action: z.enum(['manual', 'decline']),
  reason: z.string().max(2000).optional(),
}).strict()

/** An origin's host (with a non-default port) without a leading www, for headings ("github.com"). */
export function siteLabel(origin: string): string {
  try {
    return new URL(origin).host.replace(/^www\./, '')
  } catch {
    return origin
  }
}

/**
 * A one-time code as the page's field takes it, from what was typed or pasted
 * ("123 456", "123-456"): spaces always go, hyphens go for a numeric field
 * (as the container writes it), and only then does the field's length limit
 * apply — to the code, not the separators.
 */
export function compactLoginCode(value: string, field: Pick<LoginContextField, 'inputType' | 'inputMode' | 'maxLength'>): string {
  const compact = value.replace(/\s+/g, '')
  const numeric = field.inputType === 'number' || field.inputType === 'tel' || field.inputMode === 'numeric'
  const code = numeric ? compact.replace(/-/g, '') : compact
  return field.maxLength > 1 ? code.slice(0, field.maxLength) : code
}

/** Plain HTTP to anything but this machine: what is typed travels unencrypted. */
export function isInsecureOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
