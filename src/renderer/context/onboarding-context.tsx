import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { OnboardingSetupDialog } from '@renderer/components/agents/onboarding-setup-dialog'

interface OnboardingContextType {
  setOnboarding: (pending: boolean) => void
}

const OnboardingContext = createContext<OnboardingContextType | null>(null)

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [isPending, setIsPending] = useState(false)

  const setOnboarding = useCallback((pending: boolean) => {
    setIsPending(pending)
  }, [])

  return (
    <OnboardingContext.Provider value={{ setOnboarding }}>
      {children}
      <OnboardingSetupDialog open={isPending} />
    </OnboardingContext.Provider>
  )
}

export function useOnboarding() {
  const context = useContext(OnboardingContext)
  if (!context) {
    throw new Error('useOnboarding must be used within an OnboardingProvider')
  }
  return context
}
