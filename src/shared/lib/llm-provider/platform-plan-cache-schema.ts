import { z } from 'zod'

/** What one platform account may not run, and the plan that says so (SUP-1124). */
export const platformPlanPolicySchema = z.object({
  planName: z.string().nullable(),
  /** Canonical model-id prefixes the proxy refuses for this account. */
  deniedModels: z.array(z.string()),
})
export type PlatformPlanPolicy = z.infer<typeof platformPlanPolicySchema>

/** One account's cached answer. A null policy: the platform was asked and did not say. */
export const cachedPlanPolicySchema = z.object({ policy: platformPlanPolicySchema.nullable() })
