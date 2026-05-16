import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { TimezonePicker } from '@renderer/components/ui/timezone-picker'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { Wand2, TriangleAlert } from 'lucide-react'
import { UpdateSection } from './update-section'
import { useState } from 'react'

interface GeneralTabProps {
  onOpenWizard: () => void
}

export function GeneralTab({ onOpenWizard }: GeneralTabProps) {
  const { data: userSettings, isLoading: isUserSettingsLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { data: globalSettings } = useSettings()
  const updateGlobalSettings = useUpdateSettings()
  const { isAuthMode, isAdmin } = useUser()
  const showAdminFeatures = !isAuthMode || isAdmin
  const [keepAwakeLoading, setKeepAwakeLoading] = useState(false)

  const handleKeepAwakeToggle = async (checked: boolean) => {
    setKeepAwakeLoading(true)
    try {
      await window.electronAPI!.setKeepAwake(checked)
      updateUserSettings.mutate({ keepAwakeEnabled: checked })
    } catch {
      // User cancelled the sudo dialog or pmset failed — don't persist
    } finally {
      setKeepAwakeLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Appearance */}
      <div className="space-y-2">
        <Label htmlFor="theme">Appearance</Label>
        <Select
          value={userSettings?.theme ?? 'system'}
          onValueChange={(value) => {
            updateUserSettings.mutate({ theme: value as 'system' | 'light' | 'dark' })
          }}
          disabled={isUserSettingsLoading}
        >
          <SelectTrigger id="theme">
            <SelectValue placeholder="Select theme" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Choose light or dark theme, or follow your system setting
        </p>
      </div>

      {/* Timezone */}
      <div className="space-y-2">
        <Label>Timezone</Label>
        <TimezonePicker
          value={userSettings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
          onValueChange={(value) => {
            updateUserSettings.mutate({ timezone: value })
          }}
          disabled={isUserSettingsLoading}
        />
        <p className="text-xs text-muted-foreground">
          Used for interpreting scheduled task times
        </p>
      </div>

      {/* Menu Bar Icon Toggle - Only show in Electron */}
      {window.electronAPI && (
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="show-menu-bar-icon">Show in Menu Bar</Label>
            <p className="text-xs text-muted-foreground">
              Display agent status icon in the macOS menu bar
            </p>
          </div>
          <Switch
            id="show-menu-bar-icon"
            checked={userSettings?.showMenuBarIcon !== false}
            onCheckedChange={(checked: boolean) => {
              // Toggle tray visibility (instant)
              window.electronAPI?.setTrayVisible(checked)
              // Save setting in background
              updateUserSettings.mutate({ showMenuBarIcon: checked })
            }}
            disabled={isUserSettingsLoading}
          />
        </div>
      )}

      {/* Keep Awake - macOS Electron only */}
      {window.electronAPI?.platform === 'darwin' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="keep-awake">Keep Awake</Label>
              <p className="text-xs text-muted-foreground">
                Prevent your Mac from sleeping, even with the lid closed. Requires administrator access.
              </p>
            </div>
            <Switch
              id="keep-awake"
              checked={userSettings?.keepAwakeEnabled === true}
              onCheckedChange={handleKeepAwakeToggle}
              disabled={isUserSettingsLoading || keepAwakeLoading}
            />
          </div>
          <div className="flex gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
            <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0 text-yellow-500" />
            <p className="text-xs text-muted-foreground">
              This can significantly increase battery consumption. Do not use when your laptop is in a bag or enclosed space — restricted airflow with the lid closed can cause overheating.
            </p>
          </div>
        </div>
      )}

      {/* Software Updates - Only in Electron */}
      {window.electronAPI && (
        <div className="pt-4 border-t space-y-4">
          <UpdateSection />
        </div>
      )}

      {/* Share Analytics & Error Reports — non-auth mode only (auth mode has these in Analytics tab) */}
      {!isAuthMode && (
        <div className="pt-4 border-t space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="share-error-reports">Share Error Reports</Label>
              <p className="text-xs text-muted-foreground">
                Send error reports to help us diagnose and fix issues faster
              </p>
            </div>
            <Switch
              id="share-error-reports"
              checked={globalSettings?.shareErrorReports !== false}
              onCheckedChange={(checked: boolean) => {
                updateGlobalSettings.mutate({ shareErrorReports: checked })
              }}
              disabled={!globalSettings}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="share-analytics">Share Anonymous Analytics</Label>
              <p className="text-xs text-muted-foreground">
                Help improve Superagent by sharing anonymous usage data
              </p>
            </div>
            <Switch
              id="share-analytics"
              checked={!!globalSettings?.shareAnalytics}
              onCheckedChange={(checked: boolean) => {
                updateGlobalSettings.mutate({ shareAnalytics: checked })
              }}
              disabled={!globalSettings}
            />
          </div>
        </div>
      )}

      {/* Setup Wizard - admin only (wizard configures server-level settings) */}
      {showAdminFeatures && (
        <div className="pt-4 border-t space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Setup Wizard</Label>
              <p className="text-xs text-muted-foreground">
                Re-run the getting started wizard to reconfigure your setup
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={onOpenWizard} data-testid="rerun-wizard-button">
              <Wand2 className="h-4 w-4 mr-2" />
              Re-run Wizard
            </Button>
          </div>
        </div>
      )}

    </div>
  )
}
