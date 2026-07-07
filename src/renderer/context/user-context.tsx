import { createContext, useContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSession, signOut as authSignOut } from '@renderer/lib/auth-client'
import { apiFetch, clearRedirectStash, markDeliberateSignOut, clearDeliberateSignOut } from '@renderer/lib/api'
import { useAgents, resolveRouteAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import type { AgentRole } from '@shared/lib/types/agent'

interface AgentRoleInfo {
  role: AgentRole
  memberCount: number
}

interface User {
  id: string
  name: string
  email: string
  role?: string
  mustChangePassword?: boolean
}

export interface UserContextValue {
  user: User | null
  isAuthenticated: boolean
  isAdmin: boolean
  isAuthMode: boolean
  isPending: boolean
  mustChangePassword: boolean
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

// Auth mode is injected at build/dev-server time via Vite's `define` (see vite.config.ts).
// No runtime API call needed — same pattern as __APP_VERSION__.
const isAuthMode = __AUTH_MODE__

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

// __AUTH_MODE__ is a compile-time constant — only one branch survives dead code elimination.
// This avoids a wasted 404 request to /api/auth/get-session when auth is disabled.
function useAuthSession() {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (__AUTH_MODE__) return useSession()
  return { data: null, isPending: false } as ReturnType<typeof useSession>
}

// The agents list is consulted only to resolve a display slug → canonical id for
// the role lookups below, which short-circuit when auth is off — so only subscribe
// in auth mode (same compile-time gate as useAuthSession). Outside auth mode this
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
function useResolverAgents(enabled: boolean): { data: Pick<ApiAgent, 'slug' | 'displaySlug'>[] | undefined } {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (__AUTH_MODE__) return useAgents({ select: selectAgentIndex, enabled })
  return { data: undefined }
}

export function UserProvider({ children }: { children: ReactNode }) {
  // Better Auth session (only active in auth mode)
  const session = useAuthSession()
  const queryClient = useQueryClient()
  const sessionUser = isAuthMode ? (session.data?.user as User | undefined) ?? null : null
  const isPending = isAuthMode ? session.isPending : false

  const isAuthenticated = isAuthMode && sessionUser !== null
  const isAdmin = isAuthenticated && sessionUser?.role === 'admin'
  const mustChangePassword = isAuthenticated && sessionUser?.mustChangePassword === true

  // Clear the React Query cache whenever an authenticated session is LOST — the
  // manual signOut() below does this, but the 401 auto-sign-out in api.ts calls
  // better-auth's signOut directly and bypasses it. Without this, the agent route
  // loader's ensureQueryData could serve a previous user's warm-cached agent to
  // the next user on a shared tab without a server re-check. Guard
  // on a genuine true→false transition so a cold signed-out load never clears.
  //
  // Caveat: better-auth nulls session.data on ANY /get-session error (no retry),
  // so a transient network blip can also flip isAuthenticated false and clear the
  // cache. Acceptable: AuthGate already swaps the whole app to <AuthPage/> on that
  // same data=null, so the only incremental cost is a cold-cache reload (vs warm
  // re-render) once the session refetch re-succeeds — not a correctness issue.
  const wasAuthenticatedRef = useRef(false)
  useEffect(() => {
    if (isAuthenticated) {
      wasAuthenticatedRef.current = true
      // Re-arm the apiFetch 401 auto-sign-out once a session is live again —
      // signOut() below latches it off so trailing 401s from a deliberate
      // sign-out can't re-stash the signed-out user's URL.
      clearDeliberateSignOut()
    } else if (wasAuthenticatedRef.current) {
      wasAuthenticatedRef.current = false
      queryClient.clear()
    }
  }, [isAuthenticated, queryClient])

  // Fetch agent roles when authenticated
  const { data: agentRoles, isFetched: rolesFetched } = useAgentRoles(isAuthenticated)
  const rolesReady = !isAuthMode || !isAuthenticated || rolesFetched

  // `agentRoles` is keyed by the canonical agent id, but callers pass whatever
  // slug they have on hand — frequently the URL **display slug** (`{name}-{id}`),
  // which never matches an id-keyed entry. Resolve to the canonical id first so a
  // route-derived slug doesn't silently read as "no role" (false view-only).
  const { data: agents } = useResolverAgents(isAuthenticated)
  const agentRole = useCallback(
    (agentSlug: string): AgentRole | null => {
      if (!isAuthMode) return null
      const id = resolveRouteAgentId(agentSlug, agents) ?? agentSlug
      return agentRoles?.[id]?.role ?? null
    },
    [agentRoles, agents],
  )

  const agentMemberCount = useCallback(
    (agentSlug: string): number => {
      if (!isAuthMode) return 0
      const id = resolveRouteAgentId(agentSlug, agents) ?? agentSlug
      return agentRoles?.[id]?.memberCount ?? 0
    },
    [agentRoles, agents],
  )

  const canAccessAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!isAuthMode) return true
      // Note: Admins don't get implicit access here. Admin bypass is handled
      // server-side in middleware. Agents must be explicitly shared with admins
      // to appear in the UI. This is intentional for large deployments.
      return agentRole(agentSlug) !== null
    },
    [agentRole],
  )

  const canUseAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!isAuthMode) return true
      // Note: Admins don't get implicit access here. Admin bypass is handled
      // server-side in middleware. Agents must be explicitly shared with admins
      // to appear in the UI. This is intentional for large deployments.
      const role = agentRole(agentSlug)
      return role === 'owner' || role === 'user'
    },
    [agentRole],
  )

  const canAdminAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!isAuthMode) return true
      // Note: Admins don't get implicit access here. Admin bypass is handled
      // server-side in middleware. Agents must be explicitly shared with admins
      // to appear in the UI. This is intentional for large deployments.
      return agentRole(agentSlug) === 'owner'
    },
    [agentRole],
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
  }, [queryClient])

  const value = useMemo<UserContextValue>(
    () => ({
      user: sessionUser,
      isAuthenticated,
      isAdmin,
      isAuthMode,
      isPending,
      mustChangePassword,
      agentRole,
      agentMemberCount,
      canAccessAgent,
      canUseAgent,
      canAdminAgent,
      rolesReady,
      signOut,
    }),
    [
      sessionUser,
      isAuthenticated,
      isAdmin,
      isPending,
      mustChangePassword,
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
