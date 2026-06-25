import { z } from 'zod'

/**
 * Boundary check for `settings.json`, used by the fail-closed strict loader
 * (SUP-310). It deliberately validates ONLY that the file parsed to a JSON
 * *object*:
 *   - a torn / half-written file is rejected earlier by `JSON.parse`, and
 *   - a non-object (array / string / number / null) is rejected here.
 *
 * It intentionally does NOT police the (large, evolving) settings shape — the
 * permissive field-by-field merge lives in `loadSettings`. A strict shape schema
 * here would risk refusing to persist a valid but newer/partial settings file,
 * which for a file holding API keys + auth policy is itself a data-loss hazard.
 */
export const persistedSettingsSchema = z.object({}).loose()
