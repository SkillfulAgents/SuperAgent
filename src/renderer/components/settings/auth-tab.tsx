import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { Plus, X, Globe } from 'lucide-react'
import type { AuthSettings } from '@shared/lib/config/settings'

export function AuthTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const [newOrigin, setNewOrigin] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [originError, setOriginError] = useState<string | null>(null)

  const auth: AuthSettings = settings?.auth ?? {}

  const updateAuth = (partial: Partial<AuthSettings>) => {
    updateSettings.mutate({ auth: partial })
  }

  // --- Trusted Origins helpers ---
  const origins = auth.trustedOrigins ?? []

  const addOrigin = () => {
    const trimmed = newOrigin.trim()
    if (!trimmed) return
    try {
      const url = new URL(trimmed)
      const origin = url.origin
      if (origins.includes(origin)) {
        setOriginError('This origin is already in the list.')
        return
      }
      updateAuth({ trustedOrigins: [...origins, origin] })
      setNewOrigin('')
      setOriginError(null)
    } catch {
      setOriginError('Please enter a valid URL (e.g., https://example.com)')
    }
  }

  const removeOrigin = (origin: string) => {
    updateAuth({ trustedOrigins: origins.filter((o) => o !== origin) })
  }

  // --- Allowed Domains helpers ---
  const domains = auth.allowedSignupDomains ?? []

  const addDomain = () => {
    const trimmed = newDomain.trim().toLowerCase()
    if (!trimmed) return
    if (domains.includes(trimmed)) {
      setNewDomain('')
      return
    }
    updateAuth({ allowedSignupDomains: [...domains, trimmed] })
    setNewDomain('')
  }

  const removeDomain = (domain: string) => {
    updateAuth({ allowedSignupDomains: domains.filter((d) => d !== domain) })
  }

  return (
    <div className="space-y-6">
      {/* ── Signup & Access ── */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Signup & Access</h3>

        {/* Signup Mode */}
        <div className="space-y-2">
          <Label htmlFor="signup-mode">Signup Mode</Label>
          <Select
            value={auth.signupMode ?? 'invitation_only'}
            onValueChange={(value) => updateAuth({ signupMode: value as AuthSettings['signupMode'] })}
            disabled={isLoading}
          >
            <SelectTrigger id="signup-mode" data-testid="auth-signup-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="domain_restricted">Domain Restricted</SelectItem>
              <SelectItem value="invitation_only">Invitation Only</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Controls how new users can register
          </p>
        </div>

        {/* Allowed Signup Domains (only when domain_restricted) */}
        {auth.signupMode === 'domain_restricted' && (
          <div className="space-y-2">
            <Label>Allowed Signup Domains</Label>
            {domains.length > 0 ? (
              <div className="space-y-1">
                {domains.map((domain) => (
                  <div
                    key={domain}
                    className="flex items-center gap-2 px-3 py-1.5 rounded border bg-muted/30 text-sm"
                  >
                    <span className="flex-1 font-mono text-xs truncate">{domain}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 shrink-0"
                      onClick={() => removeDomain(domain)}
                      disabled={isLoading}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic py-1">
                No domains configured. All signups will be rejected.
              </p>
            )}
            <div className="flex gap-2">
              <Input
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                placeholder="example.com"
                className="h-8 text-sm font-mono"
                disabled={isLoading}
                data-testid="auth-add-domain-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addDomain()
                }}
              />
              <Button
                onClick={addDomain}
                disabled={!newDomain.trim() || isLoading}
                variant="outline"
                size="sm"
                data-testid="auth-add-domain-button"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add
              </Button>
            </div>
          </div>
        )}

        {/* Require Admin Approval */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="require-approval">Require Admin Approval</Label>
            <p className="text-xs text-muted-foreground">
              New signups require admin approval before access is granted
            </p>
          </div>
          <Switch
            id="require-approval"
            data-testid="auth-require-approval"
            checked={auth.requireAdminApproval ?? true}
            onCheckedChange={(checked) => updateAuth({ requireAdminApproval: checked })}
            disabled={isLoading}
          />
        </div>

        {/* Default User Role */}
        <div className="space-y-2">
          <Label htmlFor="default-role">Default User Role</Label>
          <Select
            value={auth.defaultUserRole ?? 'member'}
            onValueChange={(value) => updateAuth({ defaultUserRole: value as 'member' | 'admin' })}
            disabled={isLoading}
          >
            <SelectTrigger id="default-role" data-testid="auth-default-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Role assigned to new users on signup
          </p>
        </div>
      </div>

      {/* ── Authentication Methods ── */}
      <div className="border-t pt-4 space-y-4">
        <h3 className="text-sm font-medium">Authentication Methods</h3>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="allow-local-auth">Email/Password Authentication</Label>
            <p className="text-xs text-muted-foreground">
              Enable email and password login
            </p>
          </div>
          <Switch
            id="allow-local-auth"
            data-testid="auth-allow-local"
            checked={auth.allowLocalAuth ?? true}
            onCheckedChange={(checked) => updateAuth({ allowLocalAuth: checked })}
            disabled={isLoading}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="allow-social-auth">Social Login</Label>
            <p className="text-xs text-muted-foreground">
              Enable social login providers (configured separately)
            </p>
          </div>
          <Switch
            id="allow-social-auth"
            data-testid="auth-allow-social"
            checked={auth.allowSocialAuth ?? false}
            onCheckedChange={(checked) => updateAuth({ allowSocialAuth: checked })}
            disabled={isLoading}
          />
        </div>
      </div>

      {/* ── Password Policy ── */}
      <div className="border-t pt-4 space-y-4">
        <h3 className="text-sm font-medium">Password Policy</h3>

        <div className="space-y-2">
          <Label htmlFor="password-min-length">Minimum Password Length</Label>
          <Input
            id="password-min-length"
            type="number"
            min={8}
            max={128}
            value={auth.passwordMinLength ?? 12}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10)
              if (!isNaN(val) && val >= 8 && val <= 128) {
                updateAuth({ passwordMinLength: val })
              }
            }}
            className="h-8 w-24 text-sm"
            disabled={isLoading || !(auth.allowLocalAuth ?? true)}
            data-testid="auth-password-min-length"
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="require-complexity">Require Complexity</Label>
            <p className="text-xs text-muted-foreground">
              Require mix of uppercase, lowercase, numbers, and symbols
            </p>
          </div>
          <Switch
            id="require-complexity"
            data-testid="auth-require-complexity"
            checked={auth.passwordRequireComplexity ?? true}
            onCheckedChange={(checked) => updateAuth({ passwordRequireComplexity: checked })}
            disabled={isLoading || !(auth.allowLocalAuth ?? true)}
          />
        </div>
      </div>

      {/* ── Session & Lockout ── */}
      <div className="border-t pt-4 space-y-4">
        <h3 className="text-sm font-medium">Session & Lockout</h3>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="session-idle-timeout">Idle Timeout (min)</Label>
            <Input
              id="session-idle-timeout"
              type="number"
              min={5}
              value={auth.sessionIdleTimeoutMin ?? 60}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!isNaN(val) && val >= 5) updateAuth({ sessionIdleTimeoutMin: val })
              }}
              className="h-8 text-sm"
              disabled={isLoading}
              data-testid="auth-session-idle-timeout"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="session-max-lifetime">Max Lifetime (hrs)</Label>
            <Input
              id="session-max-lifetime"
              type="number"
              min={1}
              value={auth.sessionMaxLifetimeHrs ?? 24}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!isNaN(val) && val >= 1) updateAuth({ sessionMaxLifetimeHrs: val })
              }}
              className="h-8 text-sm"
              disabled={isLoading}
              data-testid="auth-session-max-lifetime"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-sessions">Max Concurrent Sessions</Label>
            <Input
              id="max-sessions"
              type="number"
              min={1}
              value={auth.maxConcurrentSessions ?? 5}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!isNaN(val) && val >= 1) updateAuth({ maxConcurrentSessions: val })
              }}
              className="h-8 text-sm"
              disabled={isLoading}
              data-testid="auth-max-sessions"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="lockout-threshold">Lockout Threshold</Label>
            <Input
              id="lockout-threshold"
              type="number"
              min={1}
              value={auth.accountLockoutThreshold ?? 10}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!isNaN(val) && val >= 1) updateAuth({ accountLockoutThreshold: val })
              }}
              className="h-8 text-sm"
              disabled={isLoading}
              data-testid="auth-lockout-threshold"
            />
            <p className="text-xs text-muted-foreground">
              Failed attempts before lock
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="lockout-duration">Lockout Duration (min)</Label>
            <Input
              id="lockout-duration"
              type="number"
              min={0}
              value={auth.accountLockoutDurationMin ?? 30}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!isNaN(val) && val >= 0) updateAuth({ accountLockoutDurationMin: val })
              }}
              className="h-8 text-sm"
              disabled={isLoading}
              data-testid="auth-lockout-duration"
            />
            <p className="text-xs text-muted-foreground">
              0 = until admin unlocks
            </p>
          </div>
        </div>
      </div>

      {/* ── Trusted Origins ── */}
      <div className="border-t pt-4 space-y-3">
        <div>
          <h3 className="text-sm font-medium">Trusted Origins</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Origins allowed for CORS and CSRF protection. If empty, all origins are permitted.
          </p>
        </div>

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

        <div className="flex gap-2">
          <Input
            value={newOrigin}
            onChange={(e) => {
              setNewOrigin(e.target.value)
              setOriginError(null)
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
        {originError && <p className="text-xs text-destructive">{originError}</p>}
      </div>
    </div>
  )
}
