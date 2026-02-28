import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { Plus, X, Globe } from 'lucide-react'

export function AuthTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const [newOrigin, setNewOrigin] = useState('')
  const [error, setError] = useState<string | null>(null)

  const origins = settings?.auth?.trustedOrigins ?? []

  const addOrigin = () => {
    const trimmed = newOrigin.trim()
    if (!trimmed) return

    // Basic URL validation
    try {
      const url = new URL(trimmed)
      const origin = url.origin
      if (origins.includes(origin)) {
        setError('This origin is already in the list.')
        return
      }
      updateSettings.mutate({ auth: { trustedOrigins: [...origins, origin] } })
      setNewOrigin('')
      setError(null)
    } catch {
      setError('Please enter a valid URL (e.g., https://example.com)')
    }
  }

  const removeOrigin = (origin: string) => {
    updateSettings.mutate({
      auth: { trustedOrigins: origins.filter((o) => o !== origin) },
    })
  }

  return (
    <div className="space-y-6">
      {/* Trusted Origins */}
      <div className="space-y-3">
        <div>
          <Label>Trusted Origins</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Origins allowed for CORS and CSRF protection. If empty, all origins are permitted (default).
          </p>
        </div>

        {/* Current origins list */}
        {origins.length > 0 ? (
          <div className="space-y-1">
            {origins.map((origin) => (
              <div
                key={origin}
                className="flex items-center gap-2 px-3 py-1.5 rounded border bg-muted/30 text-sm"
              >
                <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 font-mono text-xs truncate">{origin}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 shrink-0"
                  onClick={() => removeOrigin(origin)}
                  disabled={isLoading}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic py-2">
            No trusted origins configured. All origins are currently allowed.
          </p>
        )}

        {/* Add new origin */}
        <div className="flex gap-2">
          <Input
            value={newOrigin}
            onChange={(e) => {
              setNewOrigin(e.target.value)
              setError(null)
            }}
            placeholder="https://example.com"
            className="h-8 text-sm font-mono"
            disabled={isLoading}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addOrigin()
            }}
          />
          <Button
            onClick={addOrigin}
            disabled={!newOrigin.trim() || isLoading}
            variant="outline"
            size="sm"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {/* Future settings placeholder */}
      <div className="border-t pt-4">
        <p className="text-xs text-muted-foreground">
          Additional auth settings (password requirements, allowed email domains, OAuth providers)
          will be available in a future update.
        </p>
      </div>
    </div>
  )
}
