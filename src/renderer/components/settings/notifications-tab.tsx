import { useState, useEffect, type ReactNode } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { Info } from 'lucide-react'
import { isElectron } from '@renderer/lib/env'
import {
  requestNotificationPermission,
  hasNotificationPermission,
  showOSNotification,
} from '@renderer/lib/os-notifications'

interface SettingRowProps {
  name: string
  subtitle: ReactNode
  right: ReactNode
}

/**
 * One row inside a notification settings card — name + supporting line on the
 * left, control on the right. Visually mirrors `IntegrationRow` from the
 * agent-level connections list, minus the leading service icon.
 */
function SettingRow({ name, subtitle, right }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">{name}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </div>
  )
}

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'

export function NotificationsTab() {
  const { data: userSettings, isLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()

  const [localSettings, setLocalSettings] = useState<{
    enabled: boolean
    sessionComplete: boolean
    sessionWaiting: boolean
    sessionScheduled: boolean
  } | null>(null)

  const [browserPermission, setBrowserPermission] = useState<'granted' | 'denied' | 'default'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )

  useEffect(() => {
    if (userSettings) {
      setLocalSettings(null)
    }
  }, [userSettings])

  const notificationSettings = localSettings ?? userSettings?.notifications ?? {
    enabled: true,
    sessionComplete: true,
    sessionWaiting: true,
    sessionScheduled: true,
  }

  const updateNotificationSetting = (key: string, value: boolean) => {
    const newSettings = { ...notificationSettings, [key]: value }
    setLocalSettings(newSettings)
    updateUserSettings.mutate({ notifications: newSettings })
  }

  const handleRequestPermission = async () => {
    const granted = await requestNotificationPermission()
    setBrowserPermission(granted ? 'granted' : 'denied')
  }

  const showBrowserPermissionSection = !isElectron() && !hasNotificationPermission()

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground -mt-6">
        Only sessions you aren&apos;t viewing trigger notifications. Opening a session marks its notifications as read.
      </p>

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

      <div className={CARD_CLASS}>
        <SettingRow
          name="Session Complete Notifications"
          subtitle="Shows alerts when an agent finishes running"
          right={
            <Switch
              id="notify-session-complete"
              checked={notificationSettings.sessionComplete}
              onCheckedChange={(checked) => updateNotificationSetting('sessionComplete', checked)}
              disabled={isLoading}
            />
          }
        />
        <SettingRow
          name="Action Required Notifications"
          subtitle="Shows alerts when an agent needs input, secrets, account access, etc."
          right={
            <Switch
              id="notify-session-waiting"
              checked={notificationSettings.sessionWaiting}
              onCheckedChange={(checked) => updateNotificationSetting('sessionWaiting', checked)}
              disabled={isLoading}
            />
          }
        />
        <SettingRow
          name="Scheduled Task Started Notifications"
          subtitle="Shows alerts when a scheduled task begins running"
          right={
            <Switch
              id="notify-session-scheduled"
              checked={notificationSettings.sessionScheduled}
              onCheckedChange={(checked) => updateNotificationSetting('sessionScheduled', checked)}
              disabled={isLoading}
            />
          }
        />
      </div>

      <div className={CARD_CLASS}>
        <SettingRow
          name="Test Notifications"
          subtitle={
            <>
              Send a test notification to verify they&apos;re working.
              {isElectron() && ' This will also request macOS permission if needed.'}
            </>
          }
          right={
            <Button
              size="sm"
              variant="outline"
              onClick={() => showOSNotification('Test Notification', 'Notifications are working!')}
            >
              Send Test
            </Button>
          }
        />
      </div>
    </div>
  )
}
