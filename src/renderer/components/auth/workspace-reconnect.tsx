import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { writePreferredTarget } from '@renderer/lib/api-target'

/**
 * Shown instead of the login form when the app is driving a cloud workspace but
 * has no session for it.
 *
 * A password form would be the wrong recovery: the credential is a deployment
 * token held by the main process, and by the time this renders the proxy has
 * already tried to re-mint it and failed. The two things that can actually help
 * are reconnecting the platform account (from the local app's settings) and
 * getting back to a working app in the meantime — so returning to local is the
 * primary action rather than a footnote.
 */
export function WorkspaceReconnect() {
  const [switching, setSwitching] = useState(false)

  const switchToLocal = async () => {
    setSwitching(true)
    await writePreferredTarget('local')
    // Full reload rather than a re-render: the target is frozen for the
    // renderer's lifetime by design (see api-target.ts).
    window.location.reload()
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background p-6">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-lg font-medium">Can’t reach your cloud workspace</h1>
        <p className="text-sm text-muted-foreground">
          The app couldn’t establish a session with your organization’s workspace. Its access may
          have expired or been revoked. Reconnect your account from Settings → Account in the local
          app, then switch back.
        </p>
        <Button onClick={switchToLocal} disabled={switching}>
          {switching ? 'Switching…' : 'Use this computer instead'}
        </Button>
      </div>
    </div>
  )
}
