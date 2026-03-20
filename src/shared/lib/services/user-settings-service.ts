import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { userSettings } from '@shared/lib/db/schema'
import { getSettings } from '@shared/lib/config/settings'

// ─── Schema ──────────────────────────────────────────────────────────────────

const notificationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  sessionComplete: z.boolean().default(true),
  sessionWaiting: z.boolean().default(true),
  sessionScheduled: z.boolean().default(true),
})

export const userSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  notifications: notificationSettingsSchema.default({
    enabled: true,
    sessionComplete: true,
    sessionWaiting: true,
    sessionScheduled: true,
  }),
  setupCompleted: z.boolean().default(false),
  showMenuBarIcon: z.boolean().default(true),
  allowPrereleaseUpdates: z.boolean().default(false),
  timezone: z.string().optional(),
  agentOrder: z.array(z.string()).optional(),
  defaultApiPolicy: z.enum(['allow', 'review', 'block']).default('review'),
})

export type UserSettingsData = z.infer<typeof userSettingsSchema>

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

export function getDefaultUserSettings(): UserSettingsData {
  return userSettingsSchema.parse({ timezone: detectSystemTimezone() })
}

/**
 * Seed initial user settings for the 'local' user from existing settings.json.
 * This ensures backward compatibility when migrating from app-level to user-level settings.
 */
function seedFromAppSettings(): UserSettingsData {
  const appSettings = getSettings()
  const appPrefs = appSettings.app ?? {}

  return userSettingsSchema.parse({
    timezone: detectSystemTimezone(),
    theme: appPrefs.theme ?? 'system',
    notifications: appPrefs.notifications
      ? {
          enabled: appPrefs.notifications.enabled ?? true,
          sessionComplete: appPrefs.notifications.sessionComplete ?? true,
          sessionWaiting: appPrefs.notifications.sessionWaiting ?? true,
          sessionScheduled: appPrefs.notifications.sessionScheduled ?? true,
        }
      : undefined,
    setupCompleted: appPrefs.setupCompleted ?? false,
    showMenuBarIcon: appPrefs.showMenuBarIcon ?? true,
    allowPrereleaseUpdates: appPrefs.allowPrereleaseUpdates ?? false,
  })
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Get user settings for a given user ID.
 * Returns defaults if no row exists. For the 'local' sentinel, seeds from settings.json on first access.
 */
export function getUserSettings(userId: string): UserSettingsData {
  const rows = db
    .select({ settings: userSettings.settings })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1)
    .all()

  if (rows.length > 0) {
    try {
      return userSettingsSchema.parse(JSON.parse(rows[0].settings))
    } catch {
      // Corrupted JSON — fall through to defaults
    }
  }

  // No row found — seed from app settings for 'local' user, otherwise use defaults
  const initial = userId === 'local' ? seedFromAppSettings() : getDefaultUserSettings()

  // Persist the initial settings so future reads come from DB
  db.insert(userSettings)
    .values({
      userId,
      settings: JSON.stringify(initial),
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .run()

  return initial
}

/**
 * Update user settings with a partial update. Merges with existing, validates, and upserts.
 */
export function updateUserSettings(
  userId: string,
  partial: Partial<UserSettingsData>
): UserSettingsData {
  const current = getUserSettings(userId)

  // Deep merge notifications if provided
  const merged = {
    ...current,
    ...partial,
    notifications: partial.notifications
      ? { ...current.notifications, ...partial.notifications }
      : current.notifications,
  }

  const validated = userSettingsSchema.parse(merged)
  const json = JSON.stringify(validated)

  db.insert(userSettings)
    .values({
      userId,
      settings: json,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        settings: json,
        updatedAt: new Date(),
      },
    })
    .run()

  return validated
}

/**
 * Get a user's timezone, falling back to the system timezone or UTC.
 */
export function getUserTimezone(userId: string): string {
  const settings = getUserSettings(userId)
  return settings.timezone || detectSystemTimezone()
}
