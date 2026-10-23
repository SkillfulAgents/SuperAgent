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
  })).min(1).max(MAX_LOGIN_FIELDS),
})
export type LoginContext = z.infer<typeof loginContextSchema>
export type LoginContextField = LoginContext['fields'][number]

/** The container's answer to a fill: counts and observations, never values. */
export const loginFillResultSchema = z.object({
  success: z.literal(true),
  filled: z.number().int(),
  failed: z.number().int(),
  submitted: z.boolean(),
  problems: z.array(z.string()),
})
export type LoginFillResult = z.infer<typeof loginFillResultSchema>

/** The fill request the app sends: the origin it showed, and one value per field. */
export const fillLoginBodySchema = z.object({
  toolUseId: z.string().min(1),
  origin: z.string().min(1).max(2048),
  values: z.array(z.string().max(4096)).min(1).max(MAX_LOGIN_FIELDS),
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

/** Plain HTTP to anything but this machine: what is typed travels unencrypted. */
export function isInsecureOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
