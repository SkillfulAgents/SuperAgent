import { useState, useEffect, useRef } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'

export function PrivacyStep() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const [shareErrorReports, setShareErrorReports] = useState(true)
  const [shareAnalytics, setShareAnalytics] = useState(true)
  const initializedRef = useRef(false)

  // Initialize from current settings on first load (defaults to true for fresh installs)
  useEffect(() => {
    if (!settings || initializedRef.current) return
    initializedRef.current = true
    setShareErrorReports(settings.shareErrorReports ?? true)
    setShareAnalytics(settings.shareAnalytics ?? true)
  }, [settings])

  // Only persist after the user interacts (skip the initialization render)
  const userHasInteracted = useRef(false)
  useEffect(() => {
    if (!initializedRef.current) return
    if (!userHasInteracted.current) { userHasInteracted.current = true; return }
    updateSettings.mutate({ shareErrorReports })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareErrorReports])

  useEffect(() => {
    if (!initializedRef.current) return
    if (!userHasInteracted.current) { userHasInteracted.current = true; return }
    updateSettings.mutate({ shareAnalytics })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareAnalytics])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-normal max-w-sm">Help improve Superagent</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose what data you share with us. Error reports and anonymous analytics help us improve Superagent faster for everyone.
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
              onCheckedChange={setShareErrorReports}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Allow Superagent to send error reports when something goes wrong. Change anytime in settings.
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
              onCheckedChange={setShareAnalytics}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Share anonymous usage data to help us improve Superagent. Change anytime in settings.
          </p>
        </label>
      </div>
    </div>
  )
}
