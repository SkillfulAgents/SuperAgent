import { useState, useEffect } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { useUpdateSettings } from '@renderer/hooks/use-settings'

export function PrivacyStep() {
  const updateSettings = useUpdateSettings()
  const [shareErrorReports, setShareErrorReports] = useState(true)
  const [shareAnalytics, setShareAnalytics] = useState(true)

  useEffect(() => {
    updateSettings.mutate({ shareErrorReports })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareErrorReports])

  useEffect(() => {
    updateSettings.mutate({ shareAnalytics })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareAnalytics])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Help improve Superagent</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose what data you share with us. Error reports and anonymous analytics helps us improve Superagent faster for everyone.
        </p>
      </div>

      <div className="space-y-3">
        <label
          className="rounded-lg border border-primary p-3 cursor-pointer block"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Share error reports</span>
            <Switch
              checked={shareErrorReports}
              onCheckedChange={setShareErrorReports}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Allow Superagent to send error reports when something goes wrong. Change anytime in settings.
          </p>
        </label>

        <label
          className="rounded-lg border border-primary p-3 cursor-pointer block"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Share anonymous analytics</span>
            <Switch
              checked={shareAnalytics}
              onCheckedChange={setShareAnalytics}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Share anonymous usage data to help us improve Superagent. Change anytime in settings.
          </p>
        </label>
      </div>
    </div>
  )
}
