import { z } from 'zod'

/**
 * Zod schema for the per-agent `session-metadata.json` map, validated at the
 * file read boundary (project convention; fail-closed hardening).
 *
 * Design: deliberately LENIENT so it never rejects a legitimately-evolving file
 * (a too-strict schema would refuse to write and wedge the feature). The
 * schema's job here is to catch *corruption* — a torn/half-written file (caught
 * by JSON.parse) or a value that isn't the expected record-of-objects shape —
 * NOT to police every field. Inner objects use `.loose()` so unknown / future
 * fields pass through untouched on a read-modify-write instead of being dropped.
 *
 * Keep in sync with the `SessionMetadata` interface in
 * `@shared/lib/types/agent` (the canonical shape).
 */

const sessionUsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
    contextWindow: z.number().optional(),
  })
  .loose()

const slashCommandInfoSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    argumentHint: z.string(),
  })
  .loose()

export const sessionMetadataSchema = z
  .object({
    name: z.string().optional(),
    starred: z.boolean().optional(),
    createdAt: z.string().optional(),
    createdByUserId: z.string().optional(),
    isScheduledExecution: z.boolean().optional(),
    scheduledTaskId: z.string().optional(),
    scheduledTaskName: z.string().optional(),
    isWebhookExecution: z.boolean().optional(),
    webhookTriggerId: z.string().optional(),
    webhookTriggerName: z.string().optional(),
    isChatIntegrationSession: z.boolean().optional(),
    chatIntegrationId: z.string().optional(),
    promotedToInteractive: z.boolean().optional(),
    // Complex/structured fields are kept permissive on purpose — a strict shape
    // here risks false-rejecting a valid file and refusing to persist names.
    lastUsage: sessionUsageSchema.optional(),
    slashCommands: z.array(slashCommandInfoSchema).optional(),
    // `effort`/`model` are intentionally bare strings (not the EffortLevel enum)
    // so a newly-added level/id from a newer build never fails an older reader.
    effort: z.string().optional(),
    model: z.string().optional(),
    invokedByAgentSlug: z.string().optional(),
  })
  .loose()

export const sessionMetadataMapSchema = z.record(z.string(), sessionMetadataSchema)
