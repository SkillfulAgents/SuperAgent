import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export interface DashboardHeaderRegistration {
  agentSlug: string
  dashboardSlug: string
  dashboardName: string
  /** Start mutations owned by the dashboard view, outside AgentShell. */
  isAgentStarting?: boolean
  actions: {
    onOpenExternal: () => void
    onRefresh: () => void
    onAddToDock?: () => void
    refreshState: 'idle' | 'loading' | 'refreshing'
  } | null
}

interface DashboardHeaderContextValue {
  registration: DashboardHeaderRegistration | null
  setRegistration: React.Dispatch<React.SetStateAction<DashboardHeaderRegistration | null>>
}

const DashboardHeaderContext = createContext<DashboardHeaderContextValue | null>(null)

/**
 * Bridges dashboard-owned state (notably the iframe refresh lifecycle) into the
 * persistent AgentShell header without making the shared layout own the iframe.
 */
export function DashboardHeaderProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<DashboardHeaderRegistration | null>(null)
  const value = useMemo(
    () => ({ registration, setRegistration }),
    [registration],
  )

  return (
    <DashboardHeaderContext.Provider value={value}>
      {children}
    </DashboardHeaderContext.Provider>
  )
}

/** Registers the active dashboard's breadcrumb label and optional toolbar actions. */
export function useRegisterDashboardHeader(registration: DashboardHeaderRegistration) {
  const setRegistration = useContext(DashboardHeaderContext)?.setRegistration
  const registrationKey = `${registration.agentSlug}/${registration.dashboardSlug}`

  useLayoutEffect(() => {
    setRegistration?.(registration)
  }, [registration, setRegistration])

  useLayoutEffect(() => {
    return () => {
      setRegistration?.((current) => {
        if (!current) return null
        const currentKey = `${current.agentSlug}/${current.dashboardSlug}`
        return currentKey === registrationKey ? null : current
      })
    }
  }, [registrationKey, setRegistration])
}

/** Returns chrome only when it belongs to the currently rendered dashboard route. */
export function useDashboardHeader(
  agentSlug: string,
  dashboardSlug: string | null,
): DashboardHeaderRegistration | null {
  const registration = useContext(DashboardHeaderContext)?.registration ?? null
  if (
    !dashboardSlug
    || registration?.agentSlug !== agentSlug
    || registration.dashboardSlug !== dashboardSlug
  ) {
    return null
  }
  return registration
}
