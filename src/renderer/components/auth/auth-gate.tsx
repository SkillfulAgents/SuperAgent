import { useUser } from '@renderer/context/user-context'

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="text-muted-foreground text-sm">Loading...</div>
    </div>
  )
}

// Placeholder — replaced by the real AuthPage in Phase 6
function AuthPagePlaceholder() {
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">SuperAgent</h1>
        <p className="text-muted-foreground">Authentication required. Sign in to continue.</p>
      </div>
    </div>
  )
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthMode, isAuthenticated, isPending } = useUser()

  if (!isAuthMode) return <>{children}</>
  if (isPending) return <LoadingScreen />
  if (!isAuthenticated) return <AuthPagePlaceholder />
  return <>{children}</>
}
