import { useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { Plus, Trash2 } from 'lucide-react'
import type { AnalyticsTarget, AnalyticsTargetType } from '@shared/lib/config/settings'

const TARGET_TYPE_LABELS: Record<AnalyticsTargetType, string> = {
  amplitude: 'Amplitude',
  'google-analytics': 'Google Analytics',
  mixpanel: 'Mixpanel',
}

const TARGET_CONFIG_FIELDS: Record<AnalyticsTargetType, { key: string; label: string; placeholder: string }[]> = {
  amplitude: [{ key: 'apiKey', label: 'API Key', placeholder: 'Enter Amplitude API key' }],
  'google-analytics': [{ key: 'measurementId', label: 'Measurement ID', placeholder: 'G-XXXXXXXXXX' }],
  mixpanel: [{ key: 'token', label: 'Project Token', placeholder: 'Enter Mixpanel project token' }],
}

export function AnalyticsTab() {
  const { data: settings, isLoading: isSettingsLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { isAdmin } = useUser()

  const targets = settings?.analyticsTargets ?? []

  const [newTargetType, setNewTargetType] = useState<AnalyticsTargetType>('amplitude')
  const [newTargetConfig, setNewTargetConfig] = useState<Record<string, string>>({})
  const [showAddForm, setShowAddForm] = useState(false)

  const handleAddTarget = () => {
    const fields = TARGET_CONFIG_FIELDS[newTargetType]
    const hasAllFields = fields.every(f => newTargetConfig[f.key]?.trim())
    if (!hasAllFields) return

    const newTarget: AnalyticsTarget = {
      type: newTargetType,
      config: { ...newTargetConfig },
      enabled: true,
    }

    updateSettings.mutate({
      analyticsTargets: [...targets, newTarget],
    })
    setNewTargetConfig({})
    setShowAddForm(false)
  }

  const handleRemoveTarget = (index: number) => {
    const updated = targets.filter((_, i) => i !== index)
    updateSettings.mutate({ analyticsTargets: updated })
  }

  const handleToggleTarget = (index: number, enabled: boolean) => {
    const updated = targets.map((t, i) => i === index ? { ...t, enabled } : t)
    updateSettings.mutate({ analyticsTargets: updated })
  }

  return (
    <div className="space-y-6">
      {/* Share Error Reports */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="share-error-reports">Share Error Reports</Label>
          <p className="text-xs text-muted-foreground">
            Send error reports to help us diagnose and fix issues faster
          </p>
        </div>
        <Switch
          id="share-error-reports"
          checked={settings?.shareErrorReports !== false}
          onCheckedChange={(checked: boolean) => {
            updateSettings.mutate({ shareErrorReports: checked })
          }}
          disabled={isSettingsLoading}
        />
      </div>

      {/* Share Analytics */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="share-analytics">Share Anonymous Analytics</Label>
          <p className="text-xs text-muted-foreground">
            Help improve Superagent by sharing anonymous usage data
          </p>
        </div>
        <Switch
          id="share-analytics"
          checked={!!settings?.shareAnalytics}
          onCheckedChange={(checked: boolean) => {
            updateSettings.mutate({ shareAnalytics: checked })
          }}
          disabled={isSettingsLoading}
        />
      </div>

      {/* Analytics Targets - Admin only */}
      {isAdmin && (
        <div className="pt-4 border-t space-y-4">
          <div>
            <Label>Analytics Targets</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Send analytics events to your own analytics providers. These apply to all users.
            </p>
          </div>

          {/* Existing targets */}
          {targets.length > 0 && (
            <div className="space-y-3">
              {targets.map((target, index) => (
                <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={target.enabled}
                      onCheckedChange={(checked) => handleToggleTarget(index, checked)}
                    />
                    <div>
                      <p className="text-sm font-medium">{TARGET_TYPE_LABELS[target.type]}</p>
                      <p className="text-xs text-muted-foreground">
                        {Object.entries(target.config).map(([k, v]) =>
                          `${k}: ${v.slice(0, 8)}...`
                        ).join(', ')}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveTarget(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add new target */}
          {showAddForm ? (
            <div className="space-y-3 p-3 border rounded-lg">
              <Select
                value={newTargetType}
                onValueChange={(v) => {
                  setNewTargetType(v as AnalyticsTargetType)
                  setNewTargetConfig({})
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="amplitude">Amplitude</SelectItem>
                  <SelectItem value="google-analytics">Google Analytics</SelectItem>
                  <SelectItem value="mixpanel">Mixpanel</SelectItem>
                </SelectContent>
              </Select>

              {TARGET_CONFIG_FIELDS[newTargetType].map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label>{field.label}</Label>
                  <Input
                    type="password"
                    placeholder={field.placeholder}
                    value={newTargetConfig[field.key] ?? ''}
                    onChange={(e) => setNewTargetConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                  />
                </div>
              ))}

              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddTarget}>
                  Add
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setShowAddForm(false); setNewTargetConfig({}) }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowAddForm(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Analytics Target
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
