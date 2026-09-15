import { z } from 'zod'

export const providerImageSchema = z.string().trim().max(4096).url().refine((url) => /^https?:\/\//i.test(url))
export const avatarFilenameSchema = z.string().regex(/^[0-9a-f-]{36}\.png$/)
export const avatarOverrideSchema = z.string().regex(/^\/api\/profile\/images\/[0-9a-f-]{36}\.png$/)
export const MAX_AVATAR_BYTES = 1024 * 1024

/** Optional provider metadata must never make an otherwise valid login fail. */
export function normalizeProviderImage(value: unknown): string | null {
  const parsed = providerImageSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export interface UserImageFields {
  image?: string | null
  avatarOverride?: string | null
}

export function getUserImage(user: UserImageFields): string | null {
  const override = avatarOverrideSchema.safeParse(user.avatarOverride)
  const effective = avatarOverrideSchema.safeParse(user.image)
  return override.success ? override.data : effective.success ? effective.data : normalizeProviderImage(user.image)
}

export interface UserSummary extends UserImageFields {
  id: string
  name?: string
  email?: string
}
