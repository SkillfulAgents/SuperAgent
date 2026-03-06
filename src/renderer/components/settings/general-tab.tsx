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
import { useUser } from '@renderer/context/user-context'
import { Wand2 } from 'lucide-react'
import { UpdateSection } from './update-section'

interface GeneralTabProps {
  onOpenWizard: () => void
}

export function GeneralTab({ onOpenWizard }: GeneralTabProps) {
  const { data: userSettings, isLoading: isUserSettingsLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { isAuthMode, isAdmin } = useUser()
  const showAdminFeatures = !isAuthMode || isAdmin

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

      {/* Software Updates - Only in Electron */}
      {window.electronAPI && (
        <div className="pt-4 border-t space-y-4">
          <UpdateSection />
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
