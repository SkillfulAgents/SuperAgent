import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'
import { TimezonePicker } from '@renderer/components/ui/timezone-picker'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useUpdateStatus } from '@renderer/context/update-status-context'
import {
  Wand2,
  TriangleAlert,
  Download,
  RefreshCw,
  CheckCircle2,
  Loader2,
  Monitor,
  Sun,
  Moon,
} from 'lucide-react'

interface SettingRowProps {
  name: string
  subtitle: ReactNode
  right: ReactNode
  htmlFor?: string
}

function SettingRow({ name, subtitle, right, htmlFor }: SettingRowProps) {
  const Name = htmlFor ? 'label' : 'div'
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Name htmlFor={htmlFor} className="text-xs font-medium truncate block cursor-default">{name}</Name>
          <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </div>
  )
}

interface KeepAwakeRowProps {
  enabled: boolean
  onToggle: (checked: boolean) => void
  disabled: boolean
}

/**
 * Keep Awake row reveals its overheating warning inline only while the feature
 * is enabled — so users see the caveat exactly when it's relevant.
 */
function KeepAwakeRow({ enabled, onToggle, disabled }: KeepAwakeRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="keep-awake" className="text-xs font-medium truncate block cursor-default">Keep Awake</label>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Prevent your Mac from sleeping with the lid closed. Requires administrator access.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            id="keep-awake"
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={disabled}
          />
        </div>
      </div>
      {enabled && (
        <div className="flex gap-2 mt-2 rounded-md bg-yellow-500/10 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-500/90 leading-relaxed">
          <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            Drains battery charge faster. Avoid using in a bag or enclosed space — restricted airflow can cause overheating.
          </p>
        </div>
      )}
    </div>
  )
}

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

interface GeneralTabProps {
  onOpenWizard: () => void
}

export function GeneralTab({ onOpenWizard }: GeneralTabProps) {
  const { data: userSettings, isLoading: isUserSettingsLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { data: globalSettings } = useSettings()
  const updateGlobalSettings = useUpdateSettings()
  const { isAuthMode, isAdmin } = useUser()
  const showAdminFeatures = !isAuthMode || isAdmin
  const [keepAwakeLoading, setKeepAwakeLoading] = useState(false)

  const isElectronApp = !!window.electronAPI
  const isMacElectron = window.electronAPI?.platform === 'darwin'

  const handleKeepAwakeToggle = async (checked: boolean) => {
    setKeepAwakeLoading(true)
    try {
      await window.electronAPI!.setKeepAwake(checked)
      updateUserSettings.mutate({ keepAwakeEnabled: checked })
    } catch {
      // User cancelled the sudo dialog or pmset failed — don't persist
    } finally {
      setKeepAwakeLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {isElectronApp && (
        <div className="space-y-2">
          <h3 className={SECTION_HEADING}>Updates</h3>
          <UpdatesCard />
        </div>
      )}

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>General</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Appearance"
            subtitle="Choose light or dark theme, or follow your system setting"
            right={
              <TooltipProvider delayDuration={0}>
                {/* Single-select segmented control. Intentionally NOT Radix Tabs:
                    a theme picker has no tab panels, so TabsTrigger's aria-controls
                    would dangle (critical aria-valid-attr-value violation). */}
                <div
                  role="radiogroup"
                  aria-label="Appearance"
                  className="inline-flex h-8 items-center justify-center rounded-lg bg-muted p-0.5 text-muted-foreground"
                >
                  {(
                    [
                      { value: 'system', label: 'System', Icon: Monitor },
                      { value: 'light', label: 'Light', Icon: Sun },
                      { value: 'dark', label: 'Dark', Icon: Moon },
                    ] as const
                  ).map(({ value, label, Icon }) => {
                    const selected = (userSettings?.theme ?? 'system') === value
                    return (
                      <Tooltip key={value}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            aria-label={`${label} theme`}
                            disabled={isUserSettingsLoading}
                            onClick={() => updateUserSettings.mutate({ theme: value })}
                            className={cn(
                              'inline-flex h-7 w-8 items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
                              selected && 'bg-background text-foreground shadow',
                            )}
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{label}</TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              </TooltipProvider>
            }
          />
          <SettingRow
            name="Timezone"
            subtitle="Used for interpreting scheduled task times"
            right={
              <TimezonePicker
                value={userSettings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
                onValueChange={(value) => {
                  updateUserSettings.mutate({ timezone: value })
                }}
                disabled={isUserSettingsLoading}
                className="w-[300px] h-8"
              />
            }
          />
          {isElectronApp && (
            <SettingRow
              name="Show in Menu Bar"
              subtitle={`Display agent status icon in the ${isMacElectron ? 'menu bar' : 'system tray'}`}
              htmlFor="show-menu-bar-icon"
              right={
                <Switch
                  id="show-menu-bar-icon"
                  checked={userSettings?.showMenuBarIcon !== false}
                  onCheckedChange={(checked: boolean) => {
                    window.electronAPI?.setTrayVisible(checked)
                    updateUserSettings.mutate({ showMenuBarIcon: checked })
                  }}
                  disabled={isUserSettingsLoading}
                />
              }
            />
          )}
          {isMacElectron && (
            <KeepAwakeRow
              enabled={userSettings?.keepAwakeEnabled === true}
              onToggle={handleKeepAwakeToggle}
              disabled={isUserSettingsLoading || keepAwakeLoading}
            />
          )}
        </div>
      </div>

      {!isAuthMode && (
        <div className="space-y-2">
          <h3 className={SECTION_HEADING}>Privacy</h3>
          <div className={CARD_CLASS}>
            <SettingRow
              name="Share Error Reports"
              subtitle="Send error reports to help us diagnose and fix issues faster"
              htmlFor="share-error-reports"
              right={
                <Switch
                  id="share-error-reports"
                  checked={globalSettings?.shareErrorReports !== false}
                  onCheckedChange={(checked: boolean) => {
                    updateGlobalSettings.mutate({ shareErrorReports: checked })
                  }}
                  disabled={!globalSettings}
                />
              }
            />
            <SettingRow
              name="Share Anonymous Analytics"
              subtitle="Help improve Superagent by sharing anonymous usage data"
              htmlFor="share-analytics"
              right={
                <Switch
                  id="share-analytics"
                  checked={!!globalSettings?.shareAnalytics}
                  onCheckedChange={(checked: boolean) => {
                    updateGlobalSettings.mutate({ shareAnalytics: checked })
                  }}
                  disabled={!globalSettings}
                />
              }
            />
          </div>
        </div>
      )}

      {showAdminFeatures && (
        <div className={CARD_CLASS}>
          <SettingRow
            name="Setup Wizard"
            subtitle="Re-run the getting started wizard to reconfigure your setup"
            right={
              <Button variant="outline" size="sm" onClick={onOpenWizard} data-testid="rerun-wizard-button">
                <Wand2 className="h-4 w-4 mr-2" />
                Re-run Wizard
              </Button>
            }
          />
        </div>
      )}
    </div>
  )
}

function UpdatesCard() {
  const { data: userSettings } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { track } = useAnalyticsTracking()
  const status = useUpdateStatus()

  const handleCheck = useCallback(async () => {
    track('updates_checked')
    await window.electronAPI?.checkForUpdates()
  }, [track])

  const handleDownload = useCallback(async () => {
    await window.electronAPI?.downloadUpdate()
  }, [])

  const handleInstall = useCallback(() => {
    window.electronAPI?.installUpdate()
  }, [])

  let statusText: ReactNode = 'Check for available updates'
  if (status.state === 'checking') statusText = 'Checking for updates…'
  else if (status.state === 'not-available') statusText = 'You are on the latest version'
  else if (status.state === 'available') statusText = `Version ${status.version} is available`
  else if (status.state === 'downloading')
    statusText = (
      <>
        Downloading… <span className="tabular-nums">{Math.round(status.progress ?? 0)}%</span>
      </>
    )
  else if (status.state === 'downloaded') statusText = `Version ${status.version} is ready to install`
  else if (status.state === 'error') statusText = `Update error: ${status.error}`

  return (
    <div className={CARD_CLASS}>
      <SettingRow
        name="Software Updates"
        subtitle={statusText}
        right={
          <>
            {(status.state === 'idle' ||
              status.state === 'not-available' ||
              status.state === 'error') && (
              <Button variant="outline" size="sm" onClick={handleCheck}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Check for Updates
              </Button>
            )}
            {status.state === 'checking' && (
              <Button variant="outline" size="sm" disabled>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Checking…
              </Button>
            )}
            {status.state === 'available' && (
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            )}
            {status.state === 'downloading' && (
              <Button variant="outline" size="sm" disabled>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                <span className="tabular-nums">{Math.round(status.progress ?? 0)}%</span>
              </Button>
            )}
            {status.state === 'downloaded' && (
              <Button size="sm" onClick={handleInstall}>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Restart & Update
              </Button>
            )}
          </>
        }
      />
      <SettingRow
        name="Automatically check for updates"
        subtitle="Check on startup and periodically while the app is running"
        htmlFor="auto-check-updates"
        right={
          <Switch
            id="auto-check-updates"
            checked={userSettings?.autoCheckUpdates !== false}
            onCheckedChange={(checked: boolean) => {
              updateUserSettings.mutate({ autoCheckUpdates: checked })
            }}
          />
        }
      />
      <SettingRow
        name="Include pre-release versions"
        subtitle="Get early access to release candidates and beta versions"
        htmlFor="prerelease-updates"
        right={
          <Switch
            id="prerelease-updates"
            checked={!!userSettings?.allowPrereleaseUpdates}
            onCheckedChange={(checked: boolean) => {
              updateUserSettings.mutate({ allowPrereleaseUpdates: checked })
            }}
          />
        }
      />
    </div>
  )
}
