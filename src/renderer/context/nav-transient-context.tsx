import { createContext, useContext, useState, type ReactNode } from 'react'

interface OpenAgentSettings {
  slug: string
  tab: string
}

interface NavTransientValue {
  justCreatedSlug: string | null
  setJustCreatedSlug: (slug: string | null) => void
  openAgentSettings: OpenAgentSettings | null
  setOpenAgentSettings: (value: OpenAgentSettings | null) => void
}

const NavTransientContext = createContext<NavTransientValue | null>(null)

/**
 * Holds one-shots that must outlive in-app navigation but die on a hard
 * reload (correct for one-shots). Mounted ABOVE the router (App.tsx) so a
 * route change never resets them.
 *
 * - `justCreatedSlug`: the new-agent "morph" tag. Produced by
 *   `useCreateUntitledAgent` on create and consumed by AgentHome.
 * - `openAgentSettings`: open the agent settings dialog on a given tab once
 *   that agent's page mounts. Produced by cross-page affordances (e.g. the
 *   home graph's "edit permissions" on a connector) and consumed by AgentHome.
 */
export function NavTransientProvider({ children }: { children: ReactNode }) {
  const [justCreatedSlug, setJustCreatedSlug] = useState<string | null>(null)
  const [openAgentSettings, setOpenAgentSettings] = useState<OpenAgentSettings | null>(null)

  return (
    <NavTransientContext.Provider
      value={{ justCreatedSlug, setJustCreatedSlug, openAgentSettings, setOpenAgentSettings }}
    >
      {children}
    </NavTransientContext.Provider>
  )
}

export function useNavTransient(): NavTransientValue {
  const ctx = useContext(NavTransientContext)
  if (!ctx) throw new Error('useNavTransient must be used within a NavTransientProvider')
  return ctx
}
