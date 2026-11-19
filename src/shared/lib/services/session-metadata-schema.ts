import { z } from 'zod'
import type { SessionMetadata } from '@shared/lib/types/agent'

/**
 * Zod schema for what the app keeps about a session, validated wherever it
 * is stored or read back: an entry of the agent's session index, and an
 * entry of `session-metadata.json`, the index's portable form.
 *
 * Design: deliberately LENIENT so it never rejects a legitimately-evolving
 * entry (a too-strict schema would refuse to write and wedge the feature).
 * The schema's job here is to catch *corruption* — a value that isn't the
 * expected object shape — NOT to police every field. `.loose()` lets unknown /
 * future fields pass through untouched on a read-modify-write instead of
 * being dropped.
 *
 * Keep in sync with the `SessionMetadata` interface in
 * `@shared/lib/types/agent` (the canonical shape).
 */

/**
 * A size saved before the CLI's count (SUP-1453) is one API call's usage
 * against a window the host guessed. Its tokens become the CLI's own count of
 * that call; its window does not survive (on 1M models it was usually Haiku's
 * 200K), so the ring waits for the next turn while the token count still
 * reaches the stale-session prompt.
 */
function upgradeLegacyUsage(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const usage = value as Record<string, unknown>
  if (typeof usage.totalTokens === 'number' || typeof usage.inputTokens !== 'number') return value
  const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
  return {
    totalTokens: count('inputTokens') + count('cacheCreationInputTokens') + count('cacheReadInputTokens') + count('outputTokens'),
    contextWindow: 0,
  }
}

const sessionUsageSchema = z.preprocess(
  upgradeLegacyUsage,
  z
    .object({
      totalTokens: z.number().optional(),
      contextWindow: z.number().optional(),
    })
    .loose(),
)

const slashCommandInfoSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    argumentHint: z.string(),
  })
  .loose()

export const slashCommandListSchema = z.array(slashCommandInfoSchema)

export const sessionMetadataSchema = z
  .object({
    name: z.string().optional(),
    starred: z.boolean().optional(),
    createdAt: z.string().optional(),
    createdByUserId: z.string().optional(),
    createdByDeviceId: z.string().optional(),
    // Which device's user gets VISIBLE pushes for this session: re-stamped on
    // every device-authenticated message send ("last speaker claims the
    // alert"), explicitly null when a deviceless surface (web) spoke last.
    // Absent = never re-claimed → fall back to createdByDeviceId.
    alertDeviceId: z.string().nullable().optional(),
    isScheduledExecution: z.boolean().optional(),
    scheduledTaskId: z.string().optional(),
    scheduledTaskName: z.string().optional(),
    scheduledExecutionAt: z.string().optional(),
    isWebhookExecution: z.boolean().optional(),
    webhookTriggerId: z.string().optional(),
    webhookTriggerName: z.string().optional(),
    // Bare string/number (not enum / positive-int) for the same reason as
    // `effort`/`model` below: a status value added by a newer build must not
    // fail the whole map for an older reader. Consumers narrow at the point
    // of use (see normalizeAutomationStatus in activity-aggregation).
    automationStatus: z.string().optional(),
    webhookInvocationCount: z.number().optional(),
    isAgentIntegrationSession: z.boolean().optional(),
    agentIntegrationId: z.string().optional(),
    isChatIntegrationSession: z.boolean().optional(),
    chatIntegrationId: z.string().optional(),
    promotedToInteractive: z.boolean().optional(),
    // Complex/structured fields are kept permissive on purpose — a strict shape
    // here risks false-rejecting a valid file and refusing to persist names.
    lastUsage: sessionUsageSchema.optional(),
    slashCommands: z.array(slashCommandInfoSchema).optional(),
    // `effort`/`speed`/`model` are intentionally bare strings (not the enums)
    // so a newly-added level/id from a newer build never fails an older reader.
    effort: z.string().optional(),
    speed: z.string().optional(),
    model: z.string().optional(),
    llmProviderId: z.string().nullish(),
    errorProviders: z.record(z.string(), z.string()).optional(),
    invokedByAgentSlug: z.string().optional(),
    // Widget repair session: automated, and the slug is the dedupe key that
    // stops a permanently broken widget opening one session per refresh.
    isWidgetRepair: z.boolean().optional(),
    widgetRepairSlug: z.string().optional(),
    dispatchedByDashboardSlug: z.string().optional(),
    dispatchedByDashboardAgentSlug: z.string().optional(),
    // Fork lineage: the session this one was copied from. Provenance only —
    // a fork is a normal user session, never hidden as automated.
    forkedFromSessionId: z.string().optional(),
  })
  .loose()

/**
 * `session-metadata.json` (see `session-metadata-file`): session id → its
 * metadata, plus when its transcript was last written, which the index keeps
 * beside the metadata rather than in it.
 */
export const portableSessionMetadataSchema = sessionMetadataSchema.extend({ lastActivityAt: z.string().optional() })

export const portableSessionMetadataMapSchema = z.record(z.string(), portableSessionMetadataSchema)

export type PortableSessionMetadataMap = Record<string, SessionMetadata & { lastActivityAt?: string }>
