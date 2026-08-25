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
  platformNotification: z.boolean().default(true),
  notifyWhenUnfocused: z.boolean().default(false),
})

const homeGridLayoutSchema = z.record(
  z.string(),
  z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    w: z.number().int().min(1).max(2),
    h: z.number().int().min(1).max(2),
  })
)

const agentFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
})

/**
 * Read-tolerant list: a malformed element is dropped alone. Zod's array
 * validation is all-or-nothing, so a plain `.catch(undefined)` would let one
 * bad element discard every good sibling — and because writes re-serialize the
 * whole document, the next unrelated write would persist that as real data
 * loss.
 */
const lenientArray = <T extends z.ZodType>(element: T) =>
  z
    .array(z.unknown())
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = element.safeParse(item)
        return parsed.success ? [parsed.data] : []
      })
    )
    .optional()
    .catch(undefined)

/** Read-tolerant string map: a non-string value is dropped alone, same
 * reasoning as `lenientArray`. */
const lenientStringRecord = z
  .record(z.string(), z.unknown())
  .transform((record) => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  })
  .optional()
  .catch(undefined)

/**
 * Strict shapes for the folder fields on the write path. The stored schema is
 * deliberately lenient — reads must survive a corrupt blob — which means it
 * can only drop bad input, never reject it. The API route validates incoming
 * writes against this instead, so a malformed PUT is refused rather than
 * silently erasing the user's folders.
 */
export const agentFolderSettingsWriteSchema = z.object({
  agentFolders: z.array(agentFolderSchema).optional(),
  agentFolderAssignments: z.record(z.string(), z.string()).optional(),
  agentListOrder: z.array(z.string()).optional(),
  collapsedAgentFolders: z.array(z.string()).optional(),
})

export const userSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  notifications: notificationSettingsSchema.default({
    enabled: true,
    sessionComplete: true,
    sessionWaiting: true,
    sessionScheduled: true,
    platformNotification: true,
    notifyWhenUnfocused: false,
  }),
  setupCompleted: z.boolean().default(false),
  showMenuBarIcon: z.boolean().default(true),
  allowPrereleaseUpdates: z.boolean().default(false),
  autoCheckUpdates: z.boolean().default(true),
  timezone: z.string().optional(),
  agentOrder: z.array(z.string()).optional(),
  // Left-nav folders. A per-user projection over the shared agent list, like
  // agentOrder — filing a shared agent never moves it for anyone else. Array
  // order is the order folders render in. One level only, no nesting.
  agentFolders: lenientArray(agentFolderSchema),
  // agent slug → folder id. Both sides of this map are allowed to dangle: an
  // id pointing at a deleted folder, or a slug for an agent the user can no
  // longer see, resolves to the ungrouped root. That is what keeps folders
  // free of referential cleanup on agent/folder deletion.
  agentFolderAssignments: lenientStringRecord,
  // Top level of the left nav, in order: `agent-folder::<id>` markers for
  // every folder, the synthesized root included. Written wholesale from the
  // rendered sections on every change; it cannot be derived from agentOrder
  // because an empty folder has no member to sit behind. An earlier version of
  // this model interleaved unfiled agent slugs here — those entries still
  // parse and are ignored on read, which is the whole upgrade path. Entries
  // naming something that no longer exists are ignored, and anything missing
  // falls back to a sensible end of the list, so it never needs repairing.
  agentListOrder: lenientArray(z.string()),
  // Folder ids the user has collapsed. Absent id = expanded.
  collapsedAgentFolders: lenientArray(z.string()),
  // Home graph view: user-dragged node positions, keyed by stable node id
  // (e.g. 'agent:{slug}', 'account:{id}'). Absent entries fall back to auto-layout.
  graphNodePositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
  // Home graph view: user-dragged elbow-connector geometry, keyed by edge id.
  // coords = cross-coordinates of the route's interior segments (the
  // orthogonal waypoint model in graph-edges.tsx); sourceAngle/targetAngle =
  // pinned anchor position on the node's circular perimeter, in degrees
  // (absent = auto-picked facing side).
  graphEdgeGeometry: z.record(
    z.string(),
    z.object({
      coords: z.array(z.number()).optional(),
      sourceAngle: z.number().optional(),
      targetAngle: z.number().optional(),
      // Count-chip position as a fraction of the route's length
      chipT: z.number().optional(),
    }),
  ).optional(),
  // Home graph view: the "Details" toggle (pin every resource's detail card
  // + count chips open). Absent = off.
  graphShowDetails: z.boolean().optional(),
  // Home page widget grid: per-card position + footprint in grid cells,
  // keyed by card id (agent slug or dashboard key). Absent = never customized
  // (the board auto-packs responsively until the user drags/resizes).
  homeGridLayout: homeGridLayoutSchema.optional(),
  // Phone layout is persisted independently so arranging a responsive two-
  // column board never overwrites desktop geometry. Until customized, mobile
  // falls back to homeGridLayout and lets WidgetBoard re-pack it responsively.
  homeGridMobileLayout: homeGridLayoutSchema.optional(),
  // Agent slugs whose associated app/dashboard card is hidden from the home grid
  // (toggled from the agent card). Absent/empty = all app cards shown.
  hiddenAppCards: z.array(z.string()).optional(),
  defaultApiPolicy: z.enum(['allow', 'review', 'block']).default('review'),
  defaultMcpPolicy: z.enum(['allow', 'review', 'block']).default('review'),
  keepAwakeEnabled: z.boolean().default(false),
  onboardingProgress: z.object({
    path: z.enum(['manual', 'platform']),
    stepId: z.string(),
  }).nullish(),
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
          platformNotification: appPrefs.notifications.platformNotification ?? true,
          notifyWhenUnfocused: appPrefs.notifications.notifyWhenUnfocused ?? false,
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
