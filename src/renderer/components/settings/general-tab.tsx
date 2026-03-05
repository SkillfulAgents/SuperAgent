import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { Wand2, Check, Search, RefreshCw } from 'lucide-react'
import { UpdateSection } from './update-section'
import { cn } from '@shared/lib/utils'

const ALL_TIMEZONES = Intl.supportedValuesOf('timeZone')

function formatTimezoneOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date())
    return parts.find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

type TzEntry = { value: string; label: string; offset: string }

const FLAT_TIMEZONES: TzEntry[] = ALL_TIMEZONES.map(tz => {
  const slash = tz.indexOf('/')
  const city = slash > 0 ? tz.substring(slash + 1).replace(/_/g, ' ') : tz
  const offset = formatTimezoneOffset(tz)
  return { value: tz, label: `${city} (${offset})`, offset }
})

const POPULAR_TZ_IDS = new Set([
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Vancouver', 'America/Sao_Paulo', 'America/Mexico_City',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Europe/Istanbul',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Hong_Kong',
  'Asia/Taipei', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Bangkok',
  'Australia/Sydney', 'Australia/Melbourne',
  'Pacific/Auckland', 'Pacific/Honolulu',
  'UTC',
])
const POPULAR_TIMEZONES = FLAT_TIMEZONES.filter(tz => POPULAR_TZ_IDS.has(tz.value))

interface GeneralTabProps {
  onOpenWizard: () => void
}

export function GeneralTab({ onOpenWizard }: GeneralTabProps) {
  const { data: userSettings, isLoading: isUserSettingsLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { data: globalSettings, isLoading: isGlobalSettingsLoading } = useSettings()
  const updateGlobalSettings = useUpdateSettings()
  const { isAuthMode, isAdmin } = useUser()
  const showAdminFeatures = !isAuthMode || isAdmin
  const [tzSearch, setTzSearch] = useState('')
  const [tzFocused, setTzFocused] = useState(false)
  const tzInputRef = useRef<HTMLInputElement>(null)

  const filteredTimezones = useMemo(() => {
    const query = tzSearch.trim().toLowerCase()
    if (!query) return POPULAR_TIMEZONES
    return FLAT_TIMEZONES.filter(
      tz => tz.value.toLowerCase().includes(query) || tz.label.toLowerCase().includes(query)
    ).slice(0, 30)
  }, [tzSearch])

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const currentTz = globalSettings?.app?.timezone || systemTz
  const currentTzLabel = useMemo(() => {
    try {
      const slash = currentTz.indexOf('/')
      const city = slash > 0 ? currentTz.substring(slash + 1).replace(/_/g, ' ') : currentTz
      const abbr = new Intl.DateTimeFormat('en-US', { timeZone: currentTz, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value
      return abbr ? `${city} (${abbr})` : city
    } catch {
      return currentTz
    }
  }, [currentTz])

  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const currentTime = useMemo(() =>
    now.toLocaleTimeString(undefined, { timeZone: currentTz, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    [now, currentTz]
  )

  const selectTimezone = useCallback((tz: string) => {
    updateGlobalSettings.mutate({ app: { timezone: tz } })
    setTzSearch('')
    setTzFocused(false)
    tzInputRef.current?.blur()
  }, [updateGlobalSettings])

  return (
    <div className="space-y-6">
      {/* Appearance */}
      <div className="space-y-2">
        <Label htmlFor="theme">Appearance</Label>
        <Select
          value={userSettings?.theme ?? 'system'}
          onValueChange={(value) => {
            updateUserSettings.mutate({ theme: value as 'system' | 'light' | 'dark' })
          }}
          disabled={isUserSettingsLoading}
        >
          <SelectTrigger id="theme">
            <SelectValue placeholder="Select theme" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Choose light or dark theme, or follow your system setting
        </p>
      </div>

      {/* Timezone */}
      <div className="space-y-2">
        <Label>Timezone</Label>
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">{currentTzLabel}</p>
          <span className="text-sm tabular-nums text-muted-foreground">{currentTime}</span>
          {currentTz !== systemTz && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs gap-1"
              onClick={() => selectTimezone(systemTz)}
            >
              <RefreshCw className="h-3 w-3" />
              Sync with system
            </Button>
          )}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            ref={tzInputRef}
            placeholder="Search timezone..."
            value={tzSearch}
            onChange={(e) => setTzSearch(e.target.value)}
            onFocus={() => setTzFocused(true)}
            onBlur={() => setTimeout(() => setTzFocused(false), 150)}
            className="h-8 pl-8"
            disabled={isGlobalSettingsLoading}
          />
        </div>
        {tzFocused && (
          <div className="border rounded-md max-h-40 overflow-y-auto">
            {filteredTimezones.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">No timezone found</div>
            ) : (
              filteredTimezones.map((tz) => (
                <button
                  key={tz.value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectTimezone(tz.value)}
                  className={cn(
                    'w-full px-3 py-1.5 text-left text-sm hover:bg-accent cursor-pointer flex items-center gap-2',
                    currentTz === tz.value && 'bg-accent'
                  )}
                >
                  <Check className={cn('h-3.5 w-3.5 shrink-0', currentTz === tz.value ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{tz.value.replace(/_/g, ' ')}</span>
                  <span className="ml-auto text-xs text-muted-foreground shrink-0">{tz.offset}</span>
                </button>
              ))
            )}
            {!tzSearch.trim() && (
              <div className="px-3 py-1.5 text-xs text-muted-foreground border-t">Type to search all {ALL_TIMEZONES.length} timezones</div>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Used for scheduled tasks, time displays, and usage reports
        </p>
      </div>

      {/* Menu Bar Icon Toggle - Only show in Electron */}
      {window.electronAPI && (
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="show-menu-bar-icon">Show in Menu Bar</Label>
            <p className="text-xs text-muted-foreground">
              Display agent status icon in the macOS menu bar
            </p>
          </div>
          <Switch
            id="show-menu-bar-icon"
            checked={userSettings?.showMenuBarIcon !== false}
            onCheckedChange={(checked: boolean) => {
              // Toggle tray visibility (instant)
              window.electronAPI?.setTrayVisible(checked)
              // Save setting in background
              updateUserSettings.mutate({ showMenuBarIcon: checked })
            }}
            disabled={isUserSettingsLoading}
          />
        </div>
      )}

      {/* Software Updates - Only in Electron */}
      {window.electronAPI && (
        <div className="pt-4 border-t space-y-4">
          <UpdateSection />
        </div>
      )}

      {/* Setup Wizard - admin only (wizard configures server-level settings) */}
      {showAdminFeatures && (
        <div className="pt-4 border-t space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Setup Wizard</Label>
              <p className="text-xs text-muted-foreground">
                Re-run the getting started wizard to reconfigure your setup
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={onOpenWizard} data-testid="rerun-wizard-button">
              <Wand2 className="h-4 w-4 mr-2" />
              Re-run Wizard
            </Button>
          </div>
        </div>
      )}

    </div>
  )
}
