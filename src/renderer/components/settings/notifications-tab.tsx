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
  /** When set, the name renders as a <label> bound to the control's id. */
  htmlFor?: string
}

/**
 * One row inside a notification settings card — name + supporting line on the
 * left, control on the right. Visually mirrors `IntegrationRow` from the
 * agent-level connections list, minus the leading service icon.
 */
function SettingRow({ name, subtitle, right, htmlFor }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="block text-xs font-medium truncate">
              {name}
            </label>
          ) : (
            <div className="text-xs font-medium truncate">{name}</div>
          )}
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

  // Local state for optimistic UI updates
  const [localSettings, setLocalSettings] = useState<{
    enabled: boolean
    sessionComplete: boolean
    sessionWaiting: boolean
    sessionScheduled: boolean
    notifyWhenUnfocused: boolean
  } | null>(null)

  // Browser notification permission state
  const [browserPermission, setBrowserPermission] = useState<'granted' | 'denied' | 'default'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )

  // Reset local state when settings update
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
    notifyWhenUnfocused: false,
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
      <p className="text-xs text-muted-foreground">
        Only sessions you aren&apos;t viewing trigger notifications. Opening a session marks its
        notifications as read.
      </p>

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

      <div className={CARD_CLASS}>
        <SettingRow
          htmlFor="notifications-enabled"
          name="Enable Notifications"
          subtitle="Receive notifications for agent activity"
          right={
            <Switch
              id="notifications-enabled"
              checked={notificationSettings.enabled}
              onCheckedChange={(checked) => updateNotificationSetting('enabled', checked)}
              disabled={isLoading}
            />
          }
        />
        <SettingRow
          htmlFor="notify-session-complete"
          name="Session Complete"
          subtitle="When an agent finishes running"
          right={
            <Switch
              id="notify-session-complete"
              checked={notificationSettings.sessionComplete}
              onCheckedChange={(checked) => updateNotificationSetting('sessionComplete', checked)}
              disabled={isLoading || !notificationSettings.enabled}
            />
          }
        />
        <SettingRow
          htmlFor="notify-session-waiting"
          name="Action Required"
          subtitle="When an agent needs input (secrets, account access)"
          right={
            <Switch
              id="notify-session-waiting"
              checked={notificationSettings.sessionWaiting}
              onCheckedChange={(checked) => updateNotificationSetting('sessionWaiting', checked)}
              disabled={isLoading || !notificationSettings.enabled}
            />
          }
        />
        <SettingRow
          htmlFor="notify-session-scheduled"
          name="Scheduled Task Started"
          subtitle="When a scheduled task begins running"
          right={
            <Switch
              id="notify-session-scheduled"
              checked={notificationSettings.sessionScheduled}
              onCheckedChange={(checked) => updateNotificationSetting('sessionScheduled', checked)}
              disabled={isLoading || !notificationSettings.enabled}
            />
          }
        />
        <SettingRow
          htmlFor="notify-when-unfocused"
          name="Notify when window isn't focused"
          subtitle="Send notifications even while the session is open, as long as the SuperAgent window is behind another app. Useful for long-running sessions you've left in the background."
          right={
            <Switch
              id="notify-when-unfocused"
              checked={notificationSettings.notifyWhenUnfocused}
              onCheckedChange={(checked) => updateNotificationSetting('notifyWhenUnfocused', checked)}
              disabled={isLoading || !notificationSettings.enabled}
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
