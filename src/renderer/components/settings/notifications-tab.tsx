import { useState, useEffect } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { Bell, BellOff, Info } from 'lucide-react'
import { isElectron } from '@renderer/lib/env'
import {
  requestNotificationPermission,
  hasNotificationPermission,
  showOSNotification,
} from '@renderer/lib/os-notifications'

export function NotificationsTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  // Local state for optimistic UI updates
  const [localSettings, setLocalSettings] = useState<{
    enabled: boolean
    sessionComplete: boolean
    sessionWaiting: boolean
    sessionScheduled: boolean
  } | null>(null)

  // Browser notification permission state
  const [browserPermission, setBrowserPermission] = useState<'granted' | 'denied' | 'default'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )

  // Reset local state when settings update
  useEffect(() => {
    if (settings) {
      setLocalSettings(null)
    }
  }, [settings])

  const notificationSettings = localSettings ?? settings?.app?.notifications ?? {
    enabled: true,
    sessionComplete: true,
    sessionWaiting: true,
    sessionScheduled: true,
  }

  const updateNotificationSetting = (key: string, value: boolean) => {
    const newSettings = { ...notificationSettings, [key]: value }
    setLocalSettings(newSettings)
    updateSettings.mutate({ app: { notifications: newSettings } })
  }

  const handleRequestPermission = async () => {
    const granted = await requestNotificationPermission()
    setBrowserPermission(granted ? 'granted' : 'denied')
  }

  const showBrowserPermissionSection = !isElectron() && !hasNotificationPermission()

  return (
    <div className="space-y-6">
      {/* Global Enable/Disable */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="notifications-enabled" className="flex items-center gap-2">
            {notificationSettings.enabled ? (
              <Bell className="h-4 w-4" />
            ) : (
              <BellOff className="h-4 w-4" />
            )}
            Enable Notifications
          </Label>
          <p className="text-xs text-muted-foreground">
            Receive notifications for agent activity
          </p>
        </div>
        <Switch
          id="notifications-enabled"
          checked={notificationSettings.enabled}
          onCheckedChange={(checked) => updateNotificationSetting('enabled', checked)}
          disabled={isLoading}
        />
      </div>

      {/* Browser Permission Section (web only) */}
      {showBrowserPermissionSection && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>Browser notification permission required for OS notifications.</span>
            {browserPermission === 'denied' ? (
              <span className="text-xs text-muted-foreground">
                Permission denied. Enable in browser settings.
              </span>
            ) : (
              <Button size="sm" variant="outline" onClick={handleRequestPermission}>
                Request Permission
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Per-Type Toggles */}
      <div className="border-t pt-4 space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground">Notification Types</h3>

        {/* Session Complete */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="notify-session-complete">Session Complete</Label>
            <p className="text-xs text-muted-foreground">
              When an agent finishes running
            </p>
          </div>
          <Switch
            id="notify-session-complete"
            checked={notificationSettings.sessionComplete}
            onCheckedChange={(checked) => updateNotificationSetting('sessionComplete', checked)}
            disabled={isLoading || !notificationSettings.enabled}
          />
        </div>

        {/* Session Waiting */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="notify-session-waiting">Action Required</Label>
            <p className="text-xs text-muted-foreground">
              When an agent needs input (secrets, account access)
            </p>
          </div>
          <Switch
            id="notify-session-waiting"
            checked={notificationSettings.sessionWaiting}
            onCheckedChange={(checked) => updateNotificationSetting('sessionWaiting', checked)}
            disabled={isLoading || !notificationSettings.enabled}
          />
        </div>

        {/* Session Scheduled */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="notify-session-scheduled">Scheduled Task Started</Label>
            <p className="text-xs text-muted-foreground">
              When a scheduled task begins running
            </p>
          </div>
          <Switch
            id="notify-session-scheduled"
            checked={notificationSettings.sessionScheduled}
            onCheckedChange={(checked) => updateNotificationSetting('sessionScheduled', checked)}
            disabled={isLoading || !notificationSettings.enabled}
          />
        </div>
      </div>

      {/* Test Notification */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>Test Notifications</Label>
            <p className="text-xs text-muted-foreground">
              Send a test notification to verify they&apos;re working.
              {isElectron() && ' This will also request macOS permission if needed.'}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => showOSNotification('Test Notification', 'Notifications are working!')}
          >
            Send Test
          </Button>
        </div>
      </div>

      {/* Info about notification behavior */}
      <div className="border-t pt-4">
        <p className="text-xs text-muted-foreground">
          Notifications are only shown for sessions you&apos;re not currently viewing.
          Viewing a session automatically marks related notifications as read.
        </p>
      </div>
    </div>
  )
}
