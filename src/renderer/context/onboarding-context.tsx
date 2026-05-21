import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'

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
      <Dialog open={isPending}>
        <DialogContent className="max-w-sm [&>button]:hidden" data-testid="onboarding-setup-dialog" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader className="items-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
            <DialogTitle>Setting up your agent...</DialogTitle>
            <DialogDescription>Preparing the onboarding session</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
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
