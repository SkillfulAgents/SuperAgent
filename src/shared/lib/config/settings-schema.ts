import { z } from 'zod'

/**
 * Boundary check for the stored settings (the `settings` app record, and the
 * legacy settings.json it is imported from), applied on every read, write and
 * import. It deliberately validates ONLY that the value parsed to a JSON
 * *object*:
 *   - a torn / half-written value is rejected earlier by `JSON.parse`, and
 *   - a non-object (array / string / number / null) is rejected here.
 *
 * It intentionally does NOT police the (large, evolving) settings shape — the
 * permissive field-by-field merge lives in `mergeLoadedSettings`. A strict
 * shape schema here would risk refusing to persist valid but newer/partial
 * settings, which for a value holding API keys + auth policy is itself a
 * data-loss hazard.
 */
export const persistedSettingsSchema = z.object({}).loose()
