import type { QueryClient } from '@tanstack/react-query'
import type { SettingsPatch } from '@shared/lib/config/settings-patch'

/**
 * The one cache entry for `GET /api/settings/models`: every provider's model
 * catalog, over 100 KB. It is deliberately NOT under the `['settings']` prefix.
 * That prefix is invalidated by things that cannot change a catalog (a runtime
 * readiness change, a runner start, any settings save), and each of those used
 * to pull the whole catalog again. What does change it says so by name, through
 * `invalidateModelCatalog()` / `resetModelCatalog()`.
 */
export const MODEL_CATALOG_QUERY_KEY = ['model-catalog'] as const

/**
 * How long a mounted picker trusts the catalog. Finite on purpose: a change
 * this window is not told about (another admin's edit, a background catalog
 * sync on the server) is picked up by the next picker mounted after this.
 */
export const MODEL_CATALOG_STALE_TIME = 5 * 60 * 1000

/** The settings the models response is built from. */
const MODEL_CATALOG_SETTINGS = [
  'apiKeys',
  'enableToolSearch',
  'llmProvider',
  'modelCatalog',
  'modelPricing',
  'models',
  'webProvider',
] as const satisfies readonly (keyof SettingsPatch)[]

/** Whether a settings save touched anything the models response carries. */
export function settingsPatchChangesModelCatalog(patch: SettingsPatch): boolean {
  return MODEL_CATALOG_SETTINGS.some((key) => patch[key] !== undefined)
}

/** Refetch the catalog: a provider, connection, catalog or default-model change. */
export function invalidateModelCatalog(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: MODEL_CATALOG_QUERY_KEY })
}

/** Drop the catalog and refetch it: the account behind it changed. */
export function resetModelCatalog(queryClient: QueryClient): Promise<void> {
  return queryClient.resetQueries({ queryKey: MODEL_CATALOG_QUERY_KEY })
}
