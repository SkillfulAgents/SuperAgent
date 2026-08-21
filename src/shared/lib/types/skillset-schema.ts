/**
 * Zod schemas for skillset-related JSON persisted to disk.
 *
 * These validate at the boundary — whenever we read metadata back from disk
 * or write it, we round-trip through `.parse()`/`.safeParse()` so we don't
 * build on malformed data. New fields added in the platform skillset provider
 * (providerData, pendingQueueItemId, orgId, …) live here.
 */

import { z } from 'zod'

export const SkillProviderSchema = z.enum(['github', 'platform', 'public'])

/**
 * A skillset repo's `index.json`.
 *
 * Everything past `name`/`path`/`description`/`version` is OPTIONAL on
 * purpose: the marketplace fields (category, icon, tags, works_with,
 * developer, details) were added to the public skillset after the format
 * shipped, and a skillset repo pinned to the older shape must keep loading.
 * Unknown keys are stripped rather than rejected so the repo can add fields
 * ahead of the app understanding them.
 */
export const SkillsetIndexSkillSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().default(''),
  version: z.string().default(''),
})

export const SkillsetIndexAgentSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().default(''),
  version: z.string().default(''),
  /** Long-form markdown shown on the template details page. */
  details: z.string().optional(),
  createdAt: z.string().optional(),
  /** Free-form marketplace category, e.g. "Marketing", "Customer Success". */
  category: z.string().optional(),
  /** kebab-case lucide icon name, e.g. "badge-dollar-sign". */
  icon: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Services the template connects to; `slug` matches our service-icon set. */
  works_with: z
    .array(
      z.object({
        type: z.string(),
        slug: z.string(),
      }),
    )
    .optional(),
  developer: z
    .object({
      name: z.string(),
      url: z.string().optional(),
    })
    .optional(),
})

/**
 * The document minus its entry lists. Those stay raw here and are parsed a row
 * at a time by `parseSkillsetIndex` — see the note there on why one bad row
 * must not fail the document.
 */
const SkillsetIndexEnvelopeSchema = z.object({
  skillset_name: z.string(),
  description: z.string().default(''),
  version: z.string().default(''),
  skills: z.array(z.unknown()).default([]),
  agents: z.array(z.unknown()).optional(),
})

/**
 * The document once parsed. Nothing runs this directly — it exists to name the
 * shape `parseSkillsetIndex` returns, which assembles it row by row.
 */
const SkillsetIndexSchema = SkillsetIndexEnvelopeSchema.extend({
  skills: z.array(SkillsetIndexSkillSchema).default([]),
  agents: z.array(SkillsetIndexAgentSchema).optional(),
})

/** `<list>[<i>]: <path>: <message>` for one entry that failed to parse. */
function describeDrop(list: string, index: number, error: z.ZodError): string {
  const issue = error.issues[0]
  const at = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  return `${list}[${index}]: ${at}${issue?.message ?? 'does not match the schema'}`
}

function parseRows<T extends z.ZodType>(
  schema: T,
  list: string,
  rows: unknown[],
  dropped: string[],
): z.output<T>[] {
  const kept: z.output<T>[] = []
  rows.forEach((row, index) => {
    const parsed = schema.safeParse(row)
    if (parsed.success) kept.push(parsed.data)
    else dropped.push(describeDrop(list, index, parsed.error))
  })
  return kept
}

export type SkillsetIndexParse =
  | {
      ok: true
      index: z.output<typeof SkillsetIndexSchema>
      /** Entries that didn't match and were left out, for logging. */
      dropped: string[]
    }
  | { ok: false; error: string }

/**
 * Parse a skillset repo's `index.json`.
 *
 * The envelope must be right — with no `skillset_name` there is no skillset.
 * Individual skill and agent entries are parsed one at a time and the ones that
 * don't match are DROPPED rather than failing the document, because a document
 * failure is not recoverable downstream: `getSkillsetIndex` turns any throw
 * into `null`, which removes the skillset from Explore *and* from skill
 * discovery with nothing shown to the user. One malformed row in a third-party
 * repo — a missing `path`, `tags` written as a string — is not worth taking the
 * other 167 entries offline with it.
 */
export function parseSkillsetIndex(raw: unknown): SkillsetIndexParse {
  const envelope = SkillsetIndexEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    const issue = envelope.error.issues[0]
    const at = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    return { ok: false, error: `${at}${issue?.message ?? 'does not match the skillset index schema'}` }
  }

  const dropped: string[] = []
  const { skills, agents, ...rest } = envelope.data
  return {
    ok: true,
    dropped,
    index: {
      ...rest,
      skills: parseRows(SkillsetIndexSkillSchema, 'skills', skills, dropped),
      ...(agents === undefined
        ? {}
        : { agents: parseRows(SkillsetIndexAgentSchema, 'agents', agents, dropped) }),
    },
  }
}

export const SkillsetProviderDataSchema = z.record(z.string(), z.unknown())

export const SkillsetConfigSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string(),
  description: z.string(),
  addedAt: z.string(),
  provider: SkillProviderSchema.optional(),
  providerData: SkillsetProviderDataSchema.optional(),
})

export const InstalledSkillMetadataSchema = z.object({
  skillsetId: z.string(),
  skillsetUrl: z.string(),
  skillName: z.string(),
  skillPath: z.string(),
  installedVersion: z.string(),
  installedAt: z.string(),
  originalContentHash: z.string(),
  openPrUrl: z.string().optional(),
  provider: SkillProviderSchema.optional(),
  providerData: SkillsetProviderDataSchema.optional(),
  skillsetName: z.string().optional(),
  pendingQueueItemId: z.string().optional(),
})

export const InstalledAgentMetadataSchema = z.object({
  skillsetId: z.string(),
  skillsetUrl: z.string(),
  agentName: z.string(),
  agentPath: z.string(),
  installedVersion: z.string(),
  installedAt: z.string(),
  originalContentHash: z.string(),
  openPrUrl: z.string().optional(),
  provider: SkillProviderSchema.optional(),
  providerData: SkillsetProviderDataSchema.optional(),
  skillsetName: z.string().optional(),
  pendingQueueItemId: z.string().optional(),
})

export const PlatformAuthSettingsSchema = z.object({
  token: z.string(),
  tokenPreview: z.string(),
  email: z.string().nullable(),
  label: z.string().nullable(),
  orgId: z.string().nullish().transform((v) => v ?? null),
  orgName: z.string().nullish().transform((v) => v ?? null),
  role: z.string().nullish().transform((v) => v ?? null),
  // Platform identifiers: userId is the global user identity (used for
  // analytics); memberId is the per-org membership id (used for attribution).
  // Nullish for back-compat with records written before these were returned.
  userId: z.string().nullish().transform((v) => v ?? null),
  memberId: z.string().nullish().transform((v) => v ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// Persisted "cloud workspace" state: the durable deployment session token the
// desktop app maintains for the org's cloud deployment. `token` is a secret
// (only `tokenPreview` is ever surfaced). Bound to a specific `deploymentUrl` +
// `orgId` so a platform-side deployment change invalidates it. Validated at the
// settings boundary on read.
export const CloudWorkspaceSettingsSchema = z.object({
  deploymentUrl: z.string(),
  orgId: z.string(),
  token: z.string(),
  tokenPreview: z.string(),
  // ISO timestamp of the deployment token's expiry (from the exchange's
  // `expires_in`); we re-mint before this within a refresh buffer.
  expiresAt: z.string(),
  updatedAt: z.string(),
  // Principal the deployment session belongs to. The token is a session for one
  // user on one deployment, so it stays reusable only while the acting
  // user/member still matches. Nullish so records written before this field
  // existed still parse — they then read as "not our principal" and force a
  // re-mint instead of reusing another account's session.
  userId: z.string().nullish().transform((v) => v ?? null),
  memberId: z.string().nullish().transform((v) => v ?? null),
  // Non-reversible id for the platform credential the session was minted under.
  // Ids can be absent on a connection whose introspection never filled them in,
  // and null == null would then read as "same account"; this is always present
  // on a live connection, so it's what actually keeps sessions from crossing
  // accounts. Null (legacy record) ⇒ unattributable ⇒ re-mint.
  tokenFingerprint: z.string().nullish().transform((v) => v ?? null),
})
export type CloudWorkspaceSettings = z.infer<typeof CloudWorkspaceSettingsSchema>

// Shape returned by the platform proxy's `GET /v1/account` introspection
// route. Validated at the boundary before it's persisted into settings.
export const PlatformAccountInfoSchema = z.object({
  memberId: z.string(),
  orgId: z.string(),
  orgName: z.string().nullish().transform((v) => v ?? null),
  // Added by newer Platform proxies. Nullish keeps deployments compatible
  // during a rolling rollout where the upstream field may not exist yet.
  orgIconUrl: z.string().nullish().transform((v) => v ?? null),
  role: z.string().nullish().transform((v) => v ?? null),
  userId: z.string(),
  email: z.string().nullish().transform((v) => v ?? null),
})
export type ParsedPlatformAccountInfo = z.infer<typeof PlatformAccountInfoSchema>

// Shape returned by the platform proxy's `GET /v1/billing` route. Validated at
// the boundary before it's surfaced to the renderer. `configured: false` means
// the org has no billing workspace yet.
export const PlatformBillingInfoSchema = z.object({
  configured: z.boolean(),
  subscription: z.object({
    status: z.string().nullish().transform((v) => v ?? null),
    paymentStatus: z.string().nullish().transform((v) => v ?? null),
    currentPeriodEnd: z.string().nullish().transform((v) => v ?? null),
  }),
  seat: z
    .object({
      balanceCents: z.number(),
      startingBalanceCents: z.number(),
    })
    .nullable(),
  orgPool: z.object({
    poolBalanceCents: z.number(),
  }),
})
export type ParsedPlatformBillingInfo = z.infer<typeof PlatformBillingInfoSchema>

export type ParsedSkillsetConfig = z.infer<typeof SkillsetConfigSchema>
export type ParsedInstalledSkillMetadata = z.infer<typeof InstalledSkillMetadataSchema>
export type ParsedInstalledAgentMetadata = z.infer<typeof InstalledAgentMetadataSchema>
export type ParsedPlatformAuthSettings = z.infer<typeof PlatformAuthSettingsSchema>
