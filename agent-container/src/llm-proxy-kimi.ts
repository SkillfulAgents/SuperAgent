// Kimi reports plan limits (model or context not included) as 401, like an expired token.
export const KIMI_PLAN_LIMIT = /your current (subscription|plan)/i

export function isKimiPlanLimit(body: unknown): boolean {
  const error = (body as { error?: { message?: unknown }; message?: unknown } | null)
  const message = error?.error?.message ?? error?.message
  return typeof message === 'string' && KIMI_PLAN_LIMIT.test(message)
}
