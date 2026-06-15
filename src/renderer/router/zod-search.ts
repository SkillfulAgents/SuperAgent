/**
 * Wrap a Zod (or any `safeParse`-able) schema so a failed parse degrades to a
 * safe empty default instead of throwing.
 *
 * Used for `validateSearch` on routes where a junk query string (e.g.
 * `?detail=garbage`) should drop to the route's default state rather than crash
 * the boundary. Path params, by contrast, use strict `.parse()` — a bad path
 * segment SHOULD redirect/error (see `routes.ts`).
 *
 * Contract: every search schema passed here must have all-optional fields, so
 * that `{}` is a valid value of its output type.
 */
type SafeParseSchema<T> = {
  safeParse: (input: unknown) => { success: boolean; data?: T }
}

export function lenient<T>(schema: SafeParseSchema<T>): (raw: Record<string, unknown>) => T {
  return (raw) => {
    const result = schema.safeParse(raw)
    return result.success && result.data !== undefined ? result.data : ({} as T)
  }
}
