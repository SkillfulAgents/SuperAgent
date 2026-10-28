import { useState, useEffect, useRef } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'

export function PrivacyStep() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const [shareErrorReports, setShareErrorReports] = useState(true)
  const [shareAnalytics, setShareAnalytics] = useState(true)
  const initializedRef = useRef(false)

  // Initialize from current settings on first load. The API resolves unset values
  // to true (default-on), so fresh installs arrive here with both already true.
  useEffect(() => {
    if (!settings || initializedRef.current) return
    initializedRef.current = true
    setShareErrorReports(settings.shareErrorReports ?? true)
    setShareAnalytics(settings.shareAnalytics ?? true)
  }, [settings])

  const handleErrorReportsChange = (checked: boolean) => {
    setShareErrorReports(checked)
    updateSettings.mutate({ shareErrorReports: checked })
  }

  const handleAnalyticsChange = (checked: boolean) => {
    setShareAnalytics(checked)
    updateSettings.mutate({ shareAnalytics: checked })
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-normal max-w-sm">Help improve Gamut</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose what data you share with us. Error reports and anonymous analytics help us improve Gamut faster for everyone.
        </p>
      </div>

      <div className="space-y-3">
        <label
          htmlFor="privacy-error-reports"
          className="rounded-lg border p-3 cursor-pointer block"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Share error reports</span>
            <Switch
              id="privacy-error-reports"
              checked={shareErrorReports}
              onCheckedChange={handleErrorReportsChange}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Allow Gamut to send error reports when something goes wrong. Change anytime in settings.
          </p>
        </label>

        <label
          htmlFor="privacy-analytics"
          className="rounded-lg border p-3 cursor-pointer block"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Share anonymous analytics</span>
            <Switch
              id="privacy-analytics"
              checked={shareAnalytics}
              onCheckedChange={handleAnalyticsChange}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Share anonymous usage data to help us improve Gamut. Change anytime in settings.
          </p>
        </label>
      </div>
    </div>
  )
}
