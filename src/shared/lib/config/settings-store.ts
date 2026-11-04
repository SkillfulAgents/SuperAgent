import type { AppSettings } from './settings'

/**
 * Where the app keeps its settings. The app reads and writes settings only
 * through `getSettings()` / `mutateSettings()` in `./settings`, which call the
 * registered store; `LocalFileSettingsStore` is the default.
 *
 * Reads are synchronous. A store backed by remote storage must have the
 * settings loaded before app code reads them.
 */
export interface SettingsStore {
  /** Settings for reads. May be served from memory. Never throws. */
  get(): AppSettings
  /** Fresh read from storage. Defaults when nothing is stored; throws when the stored settings are corrupt. */
  loadStrict(): AppSettings
  /** Replace the whole settings object. Later `get()` calls return it. */
  save(settings: AppSettings): void
  /** Read fresh, apply `mutator`, save, with no lost update between concurrent callers. Returns the saved settings. */
  mutate(mutator: (settings: AppSettings) => void): AppSettings
  /** Drop any in-memory copy so the next `get()` reads storage. */
  clearCache(): void
}
