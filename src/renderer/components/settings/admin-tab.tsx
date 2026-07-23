import { useState, type ReactNode } from 'react'
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
import { useSettings, useUpdateSettings, useFactoryReset } from '@renderer/hooks/use-settings'
import { RotateCcw, Bug } from 'lucide-react'
import { DebugTab } from './debug-tab'
import { AutoDeleteSelect } from './auto-delete-select'

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

interface SettingRowProps {
  name: string
  subtitle?: ReactNode
  right: ReactNode
}

function SettingRow({ name, subtitle, right }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">{name}</div>
          {subtitle && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </div>
  )
}

export function AdminTab() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
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
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Sessions</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Session Auto-Delete"
            subtitle="Automatically delete sessions inactive for this duration. Starred sessions are preserved."
            right={
              <AutoDeleteSelect
                value={settings?.app?.autoDeleteInactiveDays}
                onChange={(days) => {
                  updateSettings.mutate({ app: { autoDeleteInactiveDays: days } })
                }}
              />
            }
          />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Danger Zone</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Factory Reset"
            subtitle="Delete all agents, sessions, files, and settings"
            right={
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
            }
          />
        </div>
      </div>

      {/* Debug */}
      <div className="space-y-2">
        <button
          onClick={() => setShowDebug(!showDebug)}
          className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
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
