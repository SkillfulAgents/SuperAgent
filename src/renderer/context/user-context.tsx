import { createContext, useContext, useCallback, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSession, signOut as authSignOut } from '@renderer/lib/auth-client'
import { apiFetch } from '@renderer/lib/api'

type AgentRole = 'owner' | 'user' | 'viewer'

interface User {
  id: string
  name: string
  email: string
  role?: string
}

interface UserContextValue {
  user: User | null
  isAuthenticated: boolean
  isAdmin: boolean
  isAuthMode: boolean
  isPending: boolean
  agentRole: (agentSlug: string) => AgentRole | null
  canAccessAgent: (agentSlug: string) => boolean
  canUseAgent: (agentSlug: string) => boolean
  canAdminAgent: (agentSlug: string) => boolean
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
      if (!res.ok) return {} as Record<string, AgentRole>
      const data = await res.json() as { roles: Record<string, AgentRole> }
      return data.roles
    },
    enabled,
    staleTime: 30_000, // Re-fetch roles every 30s
  })
}

export function UserProvider({ children }: { children: ReactNode }) {
  // Better Auth session (only active in auth mode)
  const session = useSession()
  const sessionUser = isAuthMode ? (session.data?.user as User | undefined) ?? null : null
  const isPending = isAuthMode ? session.isPending : false

  const isAuthenticated = isAuthMode && sessionUser !== null
  const isAdmin = isAuthenticated && sessionUser?.role === 'admin'

  // Fetch agent roles when authenticated
  const { data: agentRoles } = useAgentRoles(isAuthenticated)

  const agentRole = useCallback(
    (agentSlug: string): AgentRole | null => {
      if (!isAuthMode) return null
      if (isAdmin) return 'owner' // Admins have full access
      return agentRoles?.[agentSlug] ?? null
    },
    [isAdmin, agentRoles],
  )

  const canAccessAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!isAuthMode) return true
      if (isAdmin) return true
      return agentRole(agentSlug) !== null
    },
    [isAdmin, agentRole],
  )

  const canUseAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!isAuthMode) return true
      if (isAdmin) return true
      const role = agentRole(agentSlug)
      return role === 'owner' || role === 'user'
    },
    [isAdmin, agentRole],
  )

  const canAdminAgent = useCallback(
    (agentSlug: string): boolean => {
      if (!isAuthMode) return true
      if (isAdmin) return true
      return agentRole(agentSlug) === 'owner'
    },
    [isAdmin, agentRole],
  )

  const signOut = useCallback(async () => {
    await authSignOut()
  }, [])

  const value = useMemo<UserContextValue>(
    () => ({
      user: sessionUser,
      isAuthenticated,
      isAdmin,
      isAuthMode,
      isPending,
      agentRole,
      canAccessAgent,
      canUseAgent,
      canAdminAgent,
      signOut,
    }),
    [
      sessionUser,
      isAuthenticated,
      isAdmin,
      isPending,
      agentRole,
      canAccessAgent,
      canUseAgent,
      canAdminAgent,
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
