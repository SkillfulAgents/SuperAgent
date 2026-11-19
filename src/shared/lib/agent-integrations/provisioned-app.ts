/**
 * An installation whose app a team directory created for its agent
 * (team-directory/provisioning.ts): kept in the installation's config under
 * `provisionedApp`, written by the host only. A provider whose installations
 * can be provisioned spreads `provisionedAppConfigShape` into its config schema
 * and lists `provisionedApp` among its host-owned fields.
 */
import { z } from 'zod'

export const provisionedAppConfigSchema = z.object({
  /** The connected directory that created it, and whose credentials manage it. */
  directoryId: z.string(),
  /** The provider's record of the app (ids, OAuth client). Never sent to a client. */
  app: z.record(z.string(), z.unknown()),
  /** Installs it; the host adds its own `state` each time. */
  installUrl: z.string().url(),
  installed: z.boolean(),
  /** The app's name as last set. */
  name: z.string(),
  /** Whether the agent's avatar is its icon. */
  iconSet: z.boolean(),
  /** The app's settings page, for a person. */
  settingsUrl: z.string().url().optional(),
})
export type ProvisionedAppConfig = z.infer<typeof provisionedAppConfigSchema>

export const provisionedAppConfigShape = { provisionedApp: provisionedAppConfigSchema.optional() }

/** What a client sees of it. */
export interface PublicProvisionedApp {
  directoryId: string
  installed: boolean
  name: string
  iconSet: boolean
  settingsUrl?: string
}

export function publicProvisionedApp(config: string | Record<string, unknown>): PublicProvisionedApp | undefined {
  let raw: unknown
  try {
    raw = typeof config === 'string' ? JSON.parse(config) : config
  } catch {
    return undefined
  }
  const parsed = provisionedAppConfigSchema.safeParse((raw as { provisionedApp?: unknown } | null)?.provisionedApp)
  if (!parsed.success) return undefined
  const { directoryId, installed, name, iconSet, settingsUrl } = parsed.data
  return { directoryId, installed, name, iconSet, ...(settingsUrl ? { settingsUrl } : {}) }
}
