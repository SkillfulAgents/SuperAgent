import type { z } from 'zod'

/**
 * Wrap a Zod schema so a failed parse degrades to a safe empty default (`{}`)
 * instead of throwing.
 *
 * Used for `validateSearch` on routes where a junk query string (e.g.
 * `?detail=garbage`) should drop to the route's default state rather than crash
 * the boundary. Path params, by contrast, use strict `.parse()` — a bad path
 * segment SHOULD redirect/error (see `routes.ts`).
 *
 * Returns `Partial<z.output<S>>` so the `{}` fallback is well-typed WITHOUT an
 * unchecked `as T` cast (review §3.2): a search schema with a required field
 * would otherwise typecheck here while silently dropping that field at runtime.
 * In practice every schema passed has all-optional fields, so `Partial` is the
 * same shape the route components already read.
 */
export function lenient<S extends z.ZodTypeAny>(
  schema: S,
): (raw: Record<string, unknown>) => Partial<z.output<S>> {
  return (raw) => {
    const result = schema.safeParse(raw)
    return result.success ? result.data : {}
  }
}
