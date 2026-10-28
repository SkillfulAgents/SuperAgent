import { z } from 'zod'

export const ProfileFileFingerprintSchema = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
})

export const ProfileSyncManifestSchema = z.object({
  version: z.literal(1),
  profileId: z.string(),
  files: z.record(z.string(), ProfileFileFingerprintSchema),
})

export type ProfileFileFingerprint = z.infer<typeof ProfileFileFingerprintSchema>
export type ProfileSyncManifest = z.infer<typeof ProfileSyncManifestSchema>
