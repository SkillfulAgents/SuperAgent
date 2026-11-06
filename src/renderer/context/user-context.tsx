import { createContext, useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSession, signOut as authSignOut } from '@renderer/lib/auth-client'
import { forgetLoginValues } from '@shared/lib/tools/request-login/login-request-store'
import { apiFetch, clearRedirectStash, markDeliberateSignOut, clearDeliberateSignOut } from '@renderer/lib/api'
import { isAuthMode } from '@renderer/lib/auth-mode'
import { onCloudSessionRejected } from '@renderer/lib/cloud-session'
import { targetIsRemote } from '@renderer/lib/api-target'
import { useAgents, resolveRouteAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import type { AgentRole } from '@shared/lib/types/agent'

export interface AgentRoleInfo {
  role: AgentRole
  memberCount: number
}

interface User {
  id: string
  name: string
  email: string
  image?: string | null
  avatarOverride?: string | null
  role?: string
  mustChangePassword?: boolean
}

/** A cloud workspace with no session because it can't be reached right now, not because it has none. */
export type CloudWait = 'starting' | 'reconnecting'

const CLOUD_WAIT_RETRY_MS = 2_500

/**
 * A failed `get-session` that is not a 401 means the workspace did not answer
 * (restarting, waking, network), so the session is unknown rather than gone.
 * The router's not-ready body carries the route state.
 */
function cloudWaitFor(error: { status?: number; state?: unknown } | null | undefined): CloudWait | null {
  if (!error || error.status === 401) return null
  return error.state === 'waking' || error.state === 'provisioning' ? 'starting' : 'reconnecting'
}

export interface UserContextValue {
  /** Changes after every identity transition, including signing back into the same account. */
  authGeneration: object
  user: User | null
  isAuthenticated: boolean
  isAdmin: boolean
  isAuthMode: boolean
  isPending: boolean
  mustChangePassword: boolean
  /** Set while a cloud workspace can't be reached; its session is retried until it answers. */
  cloudWait: CloudWait | null
  agentRole: (agentSlug: string) => AgentRole | null
  agentMemberCount: (agentSlug: string) => number
  canAccessAgent: (agentSlug: string) => boolean
  canUseAgent: (agentSlug: string) => boolean
  canAdminAgent: (agentSlug: string) => boolean
  /** True once agent roles have been fetched (or auth mode is off) */
  rolesReady: boolean
  signOut: () => Promise<void>
}

const UserContext = createContext<UserContextValue | null>(null)

// Auth mode is resolved at boot, not at build time — a cloud workspace is an
// auth-mode deployment even though every Electron build compiles __AUTH_MODE__
// to false. See lib/auth-mode.ts. It must be read inside a render (module scope
// runs before `initApiBaseUrl()` settles the target, and reading it there
// throws).

// Fetch the current user's agent roles (only in auth mode when authenticated)
function useAgentRoles(enabled: boolean) {
  return useQuery({
    queryKey: ['my-agent-roles'],
    queryFn: async () => {
      const res = await apiFetch('/api/agents/my-roles')
      if (!res.ok) return {} as Record<string, AgentRoleInfo>
      const data = await res.json() as { roles: Record<string, AgentRoleInfo> }
      return data.roles
    },
    enabled,
    staleTime: 30_000, // Re-fetch roles every 30s
  })
}

// Conditional hook call: avoids a wasted 404 request to /api/auth/get-session
// when auth is disabled. Sound only because the branch is FROZEN for the
// renderer's lifetime — `setActiveTarget()` throws on a second assignment and
// switching targets reloads the window — so a given component instance always
// takes the same branch and hook order never shifts.
function useAuthSession() {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (isAuthMode()) return useSession()
  return { data: null, isPending: false } as ReturnType<typeof useSession>
}

// The agents list is consulted only to resolve a display slug → canonical id for
// the role lookups below, which short-circuit when auth is off — so only subscribe
// in auth mode (same gate as useAuthSession). Outside auth mode this
// avoids a wasted /api/agents fetch on every UserProvider mount.
//
// Project to just {slug, displaySlug} — all the resolver reads. React Query
// structurally shares the `select` result, so this reference stays STABLE across the
// frequent status-only `['agents']` refetches (every session state change invalidates
// that query). Subscribing to the full list here would re-run the role callbacks and
// re-render every `useUser()` consumer on each status tick.
const selectAgentIndex = (agents: ApiAgent[]): Pick<ApiAgent, 'slug' | 'displaySlug'>[] =>
  agents.map(({ slug, displaySlug }) => ({ slug, displaySlug }))

// Gated on `enabled` (isAuthenticated): while signed out, /api/agents 401s and the
// apiFetch handler signs out again → get-session refetch → AuthGate flashes
// Loading/AuthPage in a loop as React Query retries the failed query.
// Same frozen-branch reasoning as useAuthSession above.
function useResolverAgents(enabled: boolean): { data: Pick<ApiAgent, 'slug' | 'displaySlug'>[] | undefined } {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (isAuthMode()) return useAgents({ select: selectAgentIndex, enabled })
  return { data: undefined }
}

export function UserProvider({ children }: { children: ReactNode }) {
  // Frozen for this renderer's lifetime, so it is a constant from React's point
  // of view — safe in dependency arrays and behind the conditional hooks above.
  const authMode = isAuthMode()
  // Better Auth session (only active in auth mode)
  const session = useAuthSession()
  const queryClient = useQueryClient()
  const sessionUser = authMode ? (session.data?.user as User | undefined) ?? null : null
  const userId = sessionUser?.id ?? null
  const [identity, setIdentity] = useState(() => ({ userId, generation: {} }))
  const identityChanged = identity.userId !== userId
  const isPending = authMode && (session.isPending || identityChanged)

  const isAuthenticated = authMode && sessionUser !== null
  const isAdmin = isAuthenticated && sessionUser?.role === 'admin'
  const mustChangePassword = isAuthenticated && sessionUser?.mustChangePassword === true

  // A session refresh can replace A directly with B, without an observed logout.
  // Keep AuthGate mounted (it remembers whether this was a cold signed-out load),
  // but publish pending and disable our own queries until the old cache is gone.
  // The following render rebinds the query observers to the new cache entries.
  useLayoutEffect(() => {
    if (identityChanged) {
      queryClient.clear()
      forgetLoginValues()
      setIdentity({ userId, generation: {} })
    }
    if (isAuthenticated) {
      // Re-arm the apiFetch 401 auto-sign-out once a session is live again —
      // signOut() below latches it off so trailing 401s from a deliberate
      // sign-out can't re-stash the signed-out user's URL.
      clearDeliberateSignOut()
    }
  }, [identityChanged, userId, isAuthenticated, queryClient])

  // A cloud 401 must reach the session, or the UI keeps claiming to be signed in
  // while every query fails behind it (signing out is not an option there — see
  // lib/cloud-session.ts). Held in a ref because `session` is a fresh object each
  // render; subscribing to it directly would tear down and re-add the listener
  // on every render.
  const refetchSessionRef = useRef(session.refetch)
  refetchSessionRef.current = session.refetch
  useEffect(() => {
    if (!authMode) return
    return onCloudSessionRejected(() => {
      void refetchSessionRef.current?.()
    })
  }, [authMode])

  // Held across a retry: a refetch clears `error` while it is in flight, and
  // dropping the wait screen for that moment would flash the loading screen.
  const remote = authMode && targetIsRemote()
  const sessionError = (session as { error?: { status?: number; state?: unknown } | null }).error
  const settled = remote && !session.isPending
  const settledWait = settled && sessionUser === null ? cloudWaitFor(sessionError) : null
  const [lastWait, setLastWait] = useState<CloudWait | null>(null)
  if (settled && lastWait !== settledWait) setLastWait(settledWait)
  const cloudWait = !remote ? null : settled ? settledWait : lastWait
  useEffect(() => {
    if (!cloudWait || session.isPending) return
    const timer = setTimeout(() => void refetchSessionRef.current?.(), CLOUD_WAIT_RETRY_MS)
    return () => clearTimeout(timer)
  }, [cloudWait, session.isPending])

  // Fetch agent roles when authenticated
  const { data: agentRoles, isFetched: rolesFetched } = useAgentRoles(isAuthenticated && !identityChanged)
  const rolesReady = !authMode || !isAuthenticated || (!identityChanged && rolesFetched)

  // `agentRoles` is keyed by the canonical agent id, but callers pass whatever
  // slug they have on hand — frequently the URL **display slug** (`{name}-{id}`),
  // which never matches an id-keyed entry. Resolve to the canonical id first so a
  // route-derived slug doesn't silently read as "no role" (false view-only).
  const { data: agents } = useResolverAgents(isAuthenticated && !identityChanged)
  const agentRole = useCallback(
    (agentSlug: string): AgentRole | null => {
      if (!authMode || identityChanged) return null
      const id = resolveRouteAgentId(agentSlug, agents) ?? agentSlug
      return agentRoles?.[id]?.role ?? null
    },
    [authMode, identityChanged, agentRoles, agents],
  )

  const agentMemberCount = useCallback(
    (agentSlug: string): number => {
      if (!authMode || identityChanged) return 0
      const id = resolveRouteAgentId(agentSlug, agents) ?? agentSlug
      return agentRoles?.[id]?.memberCount ?? 0
    },
    [authMode, identityChanged, agentRoles, agents],
  )

  const canAccessAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!authMode) return true
      // Note: Admins don't get implicit access here. Admin bypass is handled
      // server-side in middleware. Agents must be explicitly shared with admins
      // to appear in the UI. This is intentional for large deployments.
      return agentRole(agentSlug) !== null
    },
    [authMode, agentRole],
  )

  const canUseAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!authMode) return true
      // Note: Admins don't get implicit access here. Admin bypass is handled
      // server-side in middleware. Agents must be explicitly shared with admins
      // to appear in the UI. This is intentional for large deployments.
      const role = agentRole(agentSlug)
      return role === 'owner' || role === 'user'
    },
    [authMode, agentRole],
  )

  const canAdminAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!authMode) return true
      // Note: Admins don't get implicit access here. Admin bypass is handled
      // server-side in middleware. Agents must be explicitly shared with admins
      // to appear in the UI. This is intentional for large deployments.
      return agentRole(agentSlug) === 'owner'
    },
    [authMode, agentRole],
  )

  const signOut = useCallback(async () => {
    // Gate the apiFetch 401 handler FIRST: revoking the session 401s every
    // trailing background request, and each would otherwise re-stash this
    // user's URL right after we drop it below (defeating the shared-tab
    // guard) and re-fire the auto sign-out.
    markDeliberateSignOut()
    // Drop any stashed redirect target so this user's last path can't be restored
    // into the next user's session on a shared tab (e.g. a residual stash left by
    // their own OAuth login, which peeks but never clears it).
    clearRedirectStash()
    await authSignOut()
    queryClient.clear()
    forgetLoginValues()
  }, [queryClient])

  const value = useMemo<UserContextValue>(
    () => ({
      authGeneration: identity.generation,
      user: sessionUser,
      isAuthenticated,
      isAdmin,
      isAuthMode: authMode,
      isPending,
      mustChangePassword,
      cloudWait,
      agentRole,
      agentMemberCount,
      canAccessAgent,
      canUseAgent,
      canAdminAgent,
      rolesReady,
      signOut,
    }),
    [
      identity.generation,
      sessionUser,
      isAuthenticated,
      isAdmin,
      authMode,
      isPending,
      mustChangePassword,
      cloudWait,
      agentRole,
      agentMemberCount,
      canAccessAgent,
      canUseAgent,
      canAdminAgent,
      rolesReady,
      signOut,
    ],
  )

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>
}

export function useUser() {
  const context = useContext(UserContext)
  if (!context) {
    throw new Error('useUser must be used within a UserProvider')
  }
  return context
}
