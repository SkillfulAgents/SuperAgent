import { useState, useCallback } from 'react'
import { useUser } from '@renderer/context/user-context'
import { AuthPage } from './auth-page'
import { ForcePasswordChange } from './force-password-change'

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="text-muted-foreground text-sm">Loading...</div>
    </div>
  )
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthMode, isAuthenticated, isPending, mustChangePassword } = useUser()
  const [pendingApproval, setPendingApproval] = useState(false)

  const onPendingApproval = useCallback((pending = true) => setPendingApproval(pending), [])

  if (!isAuthMode) return <>{children}</>
  if (isPending) return <LoadingScreen />
  if (!isAuthenticated || pendingApproval) return <AuthPage onPendingApproval={onPendingApproval} />
  if (mustChangePassword) return <ForcePasswordChange />
  return <>{children}</>
}
