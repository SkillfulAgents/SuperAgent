import { z } from 'zod'

/** What one platform account may not run, and the plan that says so (SUP-1124). */
export const platformPlanPolicySchema = z.object({
  planName: z.string().nullable(),
  /** Canonical model-id prefixes the proxy refuses for this account. */
  deniedModels: z.array(z.string()),
})

export type PlatformPlanPolicy = z.infer<typeof platformPlanPolicySchema>

/**
 * A snapshot in `cache:platform-plan`. `policy` null: the platform said nothing.
 * `loadedAt` is when the read behind the answer began, and `freshUntil` is when
 * to ask again. Both come from the writer's clock.
 */
export const platformPlanSnapshotSchema = z.object({
  policy: platformPlanPolicySchema.nullable(),
  loadedAt: z.number(),
  freshUntil: z.number(),
})

export type PlatformPlanSnapshot = z.infer<typeof platformPlanSnapshotSchema>

/** The invalidation epoch: an opaque id, new on every clear. */
export const platformPlanEpochSchema = z.string()

/** "Look again": a revision and nothing else, so an event says nothing about the plan. */
export const platformPlanChangedEventSchema = z.object({ revision: z.string() })
