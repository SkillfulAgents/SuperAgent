import { z } from 'zod'

export const packageSchema = z.object({ version: z.string() })
export const credentialSchema = z.object({
  token: z.string().min(1),
  user: z.object({ id: z.string().min(1), email: z.string() }),
})
export const sessionSchema = z.object({
  session: z.object({
    id: z.string(), token: z.string(), userId: z.string(),
    creationMethod: z.string().nullable().optional(), deviceId: z.string().nullable().optional(),
  }),
  user: z.object({ id: z.string(), email: z.string() }),
}).nullable()
export const pairingSchema = z.object({ token: z.string(), deploymentUrl: z.string() })
export const authorizeSchema = z.object({ url: z.string().url() })
export const devicesSchema = z.object({ devices: z.array(z.object({
  id: z.string(), deviceName: z.string().nullable(), platform: z.string().nullable(), isCurrent: z.boolean(),
})) })
export const sqliteSchemaSchema = z.array(z.object({
  type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable(),
}))
export const tableInfoSchema = z.array(z.object({ name: z.string() }))
export const privateSnapshotSchema = z.object({
  label: z.string(), schemaFingerprint: z.string(), accountColumns: z.array(z.string()),
  accounts: z.array(z.object({ id: z.string(), providerId: z.string(), accountId: z.string(), userId: z.string() })),
  passwordDigest: z.string(), mobileRefreshDigest: z.string().nullable(),
})
export const proofSchema = z.object({
  passed: z.boolean(), baselineVersion: z.string(), upgradedVersion: z.string(),
  checks: z.array(z.object({ phase: z.string(), name: z.string() })),
  elapsedMs: z.number(), error: z.string().optional(),
  coverage: z.array(z.string()),
})
