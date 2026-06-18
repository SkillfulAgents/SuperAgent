import { createContext, useContext, useState, type ReactNode } from 'react'

interface NavTransientValue {
  justCreatedSlug: string | null
  setJustCreatedSlug: (slug: string | null) => void
}

const NavTransientContext = createContext<NavTransientValue | null>(null)

/**
 * Holds the new-agent "morph" one-shot, which must outlive in-app navigation
 * but die on a hard reload (correct for a one-shot). Mounted ABOVE the router
 * (App.tsx) so a route change never resets it.
 *
 * - `justCreatedSlug`: the new-agent "morph" tag. Produced by
 *   `useCreateUntitledAgent` on create and consumed by AgentHome.
 */
export function NavTransientProvider({ children }: { children: ReactNode }) {
  const [justCreatedSlug, setJustCreatedSlug] = useState<string | null>(null)

  return (
    <NavTransientContext.Provider value={{ justCreatedSlug, setJustCreatedSlug }}>
      {children}
    </NavTransientContext.Provider>
  )
}

export function useNavTransient(): NavTransientValue {
  const ctx = useContext(NavTransientContext)
  if (!ctx) throw new Error('useNavTransient must be used within a NavTransientProvider')
  return ctx
}
