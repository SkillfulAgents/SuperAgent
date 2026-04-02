import { useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'
import { useFactoryReset } from '@renderer/hooks/use-settings'
import { RotateCcw, Bug } from 'lucide-react'
import { DebugTab } from './debug-tab'

export function AdminTab() {
  const factoryReset = useFactoryReset()
  const [isResetting, setIsResetting] = useState(false)
  const [showDebug, setShowDebug] = useState(false)

  const handleFactoryReset = async () => {
    setIsResetting(true)
    try {
      await factoryReset.mutateAsync()
      window.location.reload()
    } catch (error) {
      console.error('Factory reset failed:', error)
      setIsResetting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Danger Zone */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-destructive">Danger Zone</h3>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>Factory Reset</Label>
            <p className="text-xs text-muted-foreground">
              Delete all agents, sessions, files, and settings
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <RotateCcw className="h-4 w-4 mr-2" />
                Factory Reset
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Factory Reset</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all agents, sessions, files, scheduled tasks,
                  connected accounts, and settings. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleFactoryReset}
                  disabled={isResetting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {isResetting ? 'Resetting...' : 'Reset Everything'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Debug */}
      <div className="space-y-2">
        <button
          onClick={() => setShowDebug(!showDebug)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Bug className="h-3.5 w-3.5" />
          <span>{showDebug ? 'Hide' : 'Show'} Debug Tools</span>
        </button>
        {showDebug && (
          <div className="pt-2">
            <DebugTab />
          </div>
        )}
      </div>
    </div>
  )
}
