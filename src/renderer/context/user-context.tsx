import { createContext, useContext, useCallback, useMemo, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSession, signOut as authSignOut } from '@renderer/lib/auth-client'
import { apiFetch } from '@renderer/lib/api'
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

interface UserContextValue {
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

export function UserProvider({ children }: { children: ReactNode }) {
  // Better Auth session (only active in auth mode)
  const session = useAuthSession()
  const queryClient = useQueryClient()
  const sessionUser = isAuthMode ? (session.data?.user as User | undefined) ?? null : null
  const isPending = isAuthMode ? session.isPending : false

  const isAuthenticated = isAuthMode && sessionUser !== null
  const isAdmin = isAuthenticated && sessionUser?.role === 'admin'
  const mustChangePassword = isAuthenticated && sessionUser?.mustChangePassword === true

  // Fetch agent roles when authenticated
  const { data: agentRoles, isFetched: rolesFetched } = useAgentRoles(isAuthenticated)
  const rolesReady = !isAuthMode || !isAuthenticated || rolesFetched

  const agentRole = useCallback(
    (agentSlug: string): AgentRole | null => {
      if (!isAuthMode) return null
      return agentRoles?.[agentSlug]?.role ?? null
    },
    [agentRoles],
  )

  const agentMemberCount = useCallback(
    (agentSlug: string): number => {
      if (!isAuthMode) return 0
      return agentRoles?.[agentSlug]?.memberCount ?? 0
    },
    [agentRoles],
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
