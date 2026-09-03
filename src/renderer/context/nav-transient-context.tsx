import { createContext, useContext, useState, type ReactNode } from 'react'

export type SignupHandoff = { prompt?: string; model?: string; template_slug?: string }

/** An agent-menu action that can only run on the agent home, parked until it mounts. */
export type AgentHomeAction = { slug: string; action: 'export' | 'directory' }

interface NavTransientValue {
  justCreatedSlug: string | null
  setJustCreatedSlug: (slug: string | null) => void
  signupHandoff: SignupHandoff | null
  setSignupHandoff: (value: SignupHandoff | null) => void
  pendingAgentHomeAction: AgentHomeAction | null
  setPendingAgentHomeAction: (value: AgentHomeAction | null) => void
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
 * - `pendingAgentHomeAction`: "Export Agent" or "Agent Directory" chosen from
 *   an agent menu away from that agent's home (sidebar row, home card,
 *   breadcrumb). Produced by AgentContextMenu, which then navigates to the
 *   agent home; consumed there by opening the Share popover's Export pane or
 *   the workspace folder panel.
 */
export function NavTransientProvider({ children }: { children: ReactNode }) {
  const [justCreatedSlug, setJustCreatedSlug] = useState<string | null>(null)
  const [signupHandoff, setSignupHandoff] = useState<SignupHandoff | null>(null)
  const [pendingAgentHomeAction, setPendingAgentHomeAction] = useState<AgentHomeAction | null>(null)

  return (
    <NavTransientContext.Provider
      value={{
        justCreatedSlug,
        setJustCreatedSlug,
        signupHandoff,
        setSignupHandoff,
        pendingAgentHomeAction,
        setPendingAgentHomeAction,
      }}
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
