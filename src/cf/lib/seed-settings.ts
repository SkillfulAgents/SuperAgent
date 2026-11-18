/**
 * The settings a new org starts from. Which providers, sign-in rules and sharing an org gets is its
 * deployment's decision, so they come from the deployment as JSON (the SEED_SETTINGS variable), as
 * a server deployment seeds a settings file. Set here is only what this runtime cannot work
 * without: the Worker's own origin as trusted for sign-in.
 */
import type { AppSettings } from '@shared/lib/config/settings'

/** Changes `settings` in place; true when anything changed. */
export function seedSettings(settings: AppSettings, seedJson: string | undefined, origin: string | undefined): boolean {
  let changed = false
  // Once: an org that finished setup keeps its settings, and the caller passes no seed once a
  // deploy has applied it (TaskManagerDurableObject.prepareOrg).
  if (seedJson?.trim() && !settings.app?.setupCompleted) {
    merge(settings as unknown as Record<string, unknown>, parseSeed(seedJson))
    changed = true
  }
  const trusted = settings.auth?.trustedOrigins ?? []
  if (origin && !trusted.includes(origin)) {
    settings.auth = { ...settings.auth, trustedOrigins: [...trusted, origin] }
    changed = true
  }
  return changed
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseSeed(json: string): Record<string, unknown> {
  let seed: unknown
  try {
    seed = JSON.parse(json)
  } catch (error) {
    throw new Error('SEED_SETTINGS is not valid JSON', { cause: error })
  }
  if (!isRecord(seed)) throw new Error('SEED_SETTINGS must be a JSON object')
  return seed
}

/** A section the seed names is merged key by key; anything else is set as the seed gives it. */
function merge(settings: Record<string, unknown>, seed: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(seed)) {
    const current = settings[key]
    settings[key] = isRecord(value) && isRecord(current) ? { ...current, ...value } : value
  }
}
