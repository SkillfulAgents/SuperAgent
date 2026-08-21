import { z } from 'zod'

/**
 * A single changed setting in an audit `details` payload: either a from/to
 * pair for loggable values, or a bare status for redacted fields (secrets)
 * where only the fact of the change may be recorded.
 */
export const settingsAuditChangeSchema = z.union([
  z.object({
    from: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    to: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.enum(['set', 'updated', 'removed']),
])

export const settingsAuditDetailsSchema = z.object({
  /** Settings-UI tab labels the changed fields belong to. */
  sections: z.array(z.string()),
  /** Dotted settings paths → what changed. */
  changes: z.record(z.string(), settingsAuditChangeSchema),
})

export type SettingsAuditChange = z.infer<typeof settingsAuditChangeSchema>
export type SettingsAuditDetails = z.infer<typeof settingsAuditDetailsSchema>
