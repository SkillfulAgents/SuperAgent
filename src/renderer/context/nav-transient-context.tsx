import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

interface NavTransientValue {
  pendingDraft: string | null
  setPendingDraft: (draft: string | null) => void
  consumePendingDraft: () => string | null
  justCreatedSlug: string | null
  setJustCreatedSlug: (slug: string | null) => void
}

const NavTransientContext = createContext<NavTransientValue | null>(null)

/**
 * The slimmed remains of SelectionContext: two ephemeral one-shots that must
 * outlive in-app navigation but die on a hard reload (correct for one-shots).
 * Mounted ABOVE the router (App.tsx) so a route change never resets them.
 *
 * - `justCreatedSlug`: the new-agent "morph" tag (consumed by AgentHome, R10).
 * - `pendingDraft`: composer pre-fill. Kept for the documented contract even
 *   though its only producer (`setAgentWithDraft`) is dead in product code;
 *   `consumePendingDraft` preserves the exact read-then-clear semantics of
 *   selection-context.tsx:97-101.
 *
 * Empty of live producers in R3 — wired up as views migrate (R10).
 */
export function NavTransientProvider({ children }: { children: ReactNode }) {
  const [pendingDraft, setPendingDraft] = useState<string | null>(null)
  const [justCreatedSlug, setJustCreatedSlug] = useState<string | null>(null)

  const consumePendingDraft = useCallback(() => {
    const draft = pendingDraft
    setPendingDraft(null)
    return draft
  }, [pendingDraft])

  return (
    <NavTransientContext.Provider
      value={{ pendingDraft, setPendingDraft, consumePendingDraft, justCreatedSlug, setJustCreatedSlug }}
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
