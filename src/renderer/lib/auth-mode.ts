import { targetIsRemote } from './api-target'

/**
 * Whether the API this renderer talks to enforces identity.
 *
 * This used to be `__AUTH_MODE__` alone — a build-time constant, false in every
 * Electron build. That is right for the local API and wrong for a cloud
 * workspace, which *is* an auth-mode deployment: with it false the UI reports
 * `user: null`, `isAdmin: false`, and grants every per-agent capability
 * (`canAccessAgent` and friends return `true` unconditionally). The server still
 * enforces, so that is not a security hole — but the UI offers every action on
 * every agent and the user discovers their real permissions as a stream of 403s.
 *
 * Derived from the target rather than stored separately, so the two can never
 * disagree. `__AUTH_MODE__` remains the default; a cloud target only ever
 * overrides it to `true`.
 *
 * **Frozen before first render.** `useAuthSession()` and `useResolverAgents()`
 * call hooks *conditionally* on this value behind a `rules-of-hooks` disable.
 * That is sound only while the answer is stable for the renderer's lifetime,
 * which reload-on-switch guarantees and `setActiveTarget()` enforces. Reading it
 * before boot settles the target throws (see `api-target.ts`) rather than
 * guessing — a module that read it early would take the wrong branch and produce
 * a hooks-order crash that reproduces only in cloud mode.
 */
export function isAuthMode(): boolean {
  return __AUTH_MODE__ || targetIsRemote()
}

/**
 * Whether there is a login screen to offer when no session exists.
 *
 * True only for a web auth-mode deployment, where the credential is a password
 * or an OAuth identity the user can supply. A cloud workspace's credential is
 * the proxy's bearer token, held by the main process — there is nothing to type,
 * so the recovery is reconnecting the workspace (or returning to local), not a
 * password form.
 */
export function hasInteractiveLogin(): boolean {
  return isAuthMode() && !targetIsRemote()
}
