import { useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'

export function BrowserTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  // Optimistic local state
  const [useHostBrowser, setUseHostBrowser] = useState<boolean | null>(null)
  const [chromeProfileId, setChromeProfileId] = useState<string | null>(null)

  const effectiveUseHostBrowser = useHostBrowser ?? settings?.app?.useHostBrowser ?? false
  const effectiveChromeProfileId = chromeProfileId ?? settings?.app?.chromeProfileId ?? ''

  return (
    <div className="space-y-6">
      {/* Use My Browser toggle */}
      {settings?.hostBrowserStatus && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="use-host-browser">Use My Browser</Label>
              <p className="text-xs text-muted-foreground">
                {settings.hostBrowserStatus.available === false
                  ? 'No supported browser detected on your system.'
                  : 'Use your machine\'s browser instead of the built-in headless browser. Reduces bot detection.'}
              </p>
            </div>
            <Switch
              id="use-host-browser"
              checked={effectiveUseHostBrowser}
              onCheckedChange={(checked) => {
                setUseHostBrowser(checked)
                updateSettings.mutate({ app: { useHostBrowser: checked } })
              }}
              disabled={isLoading || !settings.hostBrowserStatus.available}
            />
          </div>
        </div>
      )}

      {/* Chrome Profile selector */}
      {settings?.hostBrowserStatus?.profiles && settings.hostBrowserStatus.profiles.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="chrome-profile">Chrome Profile</Label>
          <Select
            value={effectiveChromeProfileId || '__none__'}
            onValueChange={(value) => {
              const profileId = value === '__none__' ? '' : value
              setChromeProfileId(profileId)
              updateSettings.mutate({
                app: { chromeProfileId: profileId },
              })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="chrome-profile">
              <SelectValue placeholder="Select a Chrome profile" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None (clean profile)</SelectItem>
              {settings.hostBrowserStatus.profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Use cookies and login sessions from a Chrome profile. Data is copied fresh each time the browser launches.
          </p>
        </div>
      )}
    </div>
  )
}
