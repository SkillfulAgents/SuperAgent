/**
 * Zod schemas for skillset-related JSON persisted to disk.
 *
 * These validate at the boundary — whenever we read metadata back from disk
 * or write it, we round-trip through `.parse()`/`.safeParse()` so we don't
 * build on malformed data. New fields added in the platform skillset provider
 * (providerData, pendingQueueItemId, orgId, …) live here.
 */

import { z } from 'zod'

export const SkillProviderSchema = z.enum(['github', 'platform'])

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
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type ParsedSkillsetConfig = z.infer<typeof SkillsetConfigSchema>
export type ParsedInstalledSkillMetadata = z.infer<typeof InstalledSkillMetadataSchema>
export type ParsedInstalledAgentMetadata = z.infer<typeof InstalledAgentMetadataSchema>
export type ParsedPlatformAuthSettings = z.infer<typeof PlatformAuthSettingsSchema>
