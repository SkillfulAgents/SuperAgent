import { AsyncLocalStorage } from 'node:async_hooks'
import { captureException } from '@shared/lib/error-reporting'
import { isPlatformControlledAuth } from './auth-settings'
import { PlatformOrgRoleSchema } from './platform-role-schema'

// On a platform-controlled deployment a member joins with their Platform role:
// owners and admins become admins, members become users. It is written in the
// INSERT that creates their user, so it holds whichever overlapping sign-in
// creates the user and whichever links their account, and nothing writes it
// again: a role changed later in Settings > Users stays, and someone who links
// Platform to a user they already had keeps their role. These deployments skip
// the first-user promotion unless the platform sent no role it recognizes.

interface SignInState {
  /** Set once this request is known to be a Platform sign-in. */
  platform?: { role: unknown }
  /** Set when this request created a user without a recognized Platform role. */
  bootstrap?: boolean
}

const signIn = new AsyncLocalStorage<SignInState>()

/** Run one auth request with a place for its Platform role, filled in by `notePlatformRole`. */
export function runAuthRequest<T>(fn: () => T): T {
  return signIn.run({}, fn)
}

/** Run a desktop exchange, whose grant already carries the Platform role. */
export function runPlatformSignIn<T>(platformRole: unknown, fn: () => T): T {
  return signIn.run({ platform: { role: platformRole } }, fn)
}

/** Browser sign-in: the verified Platform profile, seen before any user is created. */
export function notePlatformRole(platformRole: unknown): void {
  const state = signIn.getStore()
  if (state) state.platform = { role: platformRole }
}

/**
 * From the user create hook, before the insert: the role a member joining from
 * Platform is created with. A missing or unknown role is reported and leaves
 * the default role, with the first-user promotion allowed to run.
 */
export function platformJoinRole(): 'admin' | 'user' | undefined {
  const state = signIn.getStore()
  if (!state?.platform || !isPlatformControlledAuth()) return undefined
  const parsed = PlatformOrgRoleSchema.safeParse(state.platform.role)
  if (parsed.success) return parsed.data === 'member' ? 'user' : 'admin'
  const { role } = state.platform
  captureException(new Error('Unrecognized platform role'), {
    tags: { area: 'auth', op: 'platform-role' },
    extra: { platformRole: typeof role === 'string' ? role.slice(0, 64) : typeof role },
  })
  state.bootstrap = true
  return undefined
}

/** From the user create hook, after the insert: whether the first-user promotion may run. */
export function firstUserPromotionApplies(): boolean {
  return !isPlatformControlledAuth() || signIn.getStore()?.bootstrap === true
}
