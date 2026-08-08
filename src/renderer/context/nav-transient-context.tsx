import { createContext, useContext, useState, type ReactNode } from 'react'

export type SignupHandoff = { prompt?: string; model?: string }

interface NavTransientValue {
  justCreatedSlug: string | null
  setJustCreatedSlug: (slug: string | null) => void
  signupHandoff: SignupHandoff | null
  setSignupHandoff: (value: SignupHandoff | null) => void
}

const NavTransientContext = createContext<NavTransientValue | null>(null)

/**
 * Holds one-shots that must outlive in-app navigation but die on a hard
 * reload (correct for one-shots). Mounted ABOVE the router (App.tsx) so a
 * route change never resets them.
 *
 * - `justCreatedSlug`: the new-agent "morph" tag. Produced by
 *   `useCreateUntitledAgent` on create and consumed by AgentHome.
 * - `signupHandoff`: marketing-site prompt+model prefill for the first-run
 *   create box. Produced by SignupHandoffConsumer and consumed by CreateAgentForm.
 */
export function NavTransientProvider({ children }: { children: ReactNode }) {
  const [justCreatedSlug, setJustCreatedSlug] = useState<string | null>(null)
  const [signupHandoff, setSignupHandoff] = useState<SignupHandoff | null>(null)

  return (
    <NavTransientContext.Provider
      value={{ justCreatedSlug, setJustCreatedSlug, signupHandoff, setSignupHandoff }}
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
