import { useState, useEffect, useMemo } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings, useStartRunner, useRestartRunner, useRefreshAvailability } from '@renderer/hooks/use-settings'
import { AlertCircle, AlertTriangle, Play, Download, Loader2, RefreshCw, Plus, X } from 'lucide-react'
import { RunnerSetupErrorPanel, getRunnerSetupPayload } from '@renderer/components/settings/runner-setup-error-panel'
import { RuntimeProvisionProgress } from '@renderer/components/runtime/runtime-provision-progress'
import { DEFAULT_LIMA_VM_MEMORY, VALID_LIMA_VM_MEMORY_OPTIONS } from '@shared/lib/container/types'
import { assessVmMemory } from '@shared/lib/container/vm-memory'
import { findReservedEnvVarKeys } from '@shared/lib/container/reserved-env-vars'
import { getDefaultAgentImage } from '@shared/lib/config/version'

const CPU_LIMIT_OPTIONS = [1, 2, 4, 6, 8]
const MEMORY_LIMIT_OPTIONS: { value: string; label: string }[] = [
  { value: '512m', label: '512 MB' },
  { value: '1g', label: '1 GB' },
  { value: '2g', label: '2 GB' },
  { value: '4g', label: '4 GB' },
  { value: '8g', label: '8 GB' },
  { value: '16g', label: '16 GB' },
  { value: '32g', label: '32 GB' },
]

const RUNNER_LABELS: Record<string, string> = {
  'apple-container': 'macOS Container',
  docker: 'Docker',
  podman: 'Podman',
  lima: 'Built-in Runtime',
  wsl2: 'Built-in Runtime',
}

function normalizeEnvVarName(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

/**
 * Per-runtime settings definitions.
 * Each runtime declares its configurable fields with metadata for rendering.
 */
interface RuntimeSettingField {
  key: string
  label: string
  description: string
  type: 'select' | 'text'
  options?: { value: string; label: string }[]
  defaultValue: string
}

const MEMORY_LABELS: Record<string, string> = {
  '2GiB': '2 GB', '4GiB': '4 GB', '6GiB': '6 GB',
  '8GiB': '8 GB', '12GiB': '12 GB', '16GiB': '16 GB',
}

const RUNTIME_SETTINGS: Record<string, RuntimeSettingField[]> = {
  lima: [
    {
      key: 'vmMemory',
      label: 'VM Memory',
      description: 'Maximum memory for the built-in runtime VM. Only used as needed.',
      type: 'select',
      options: VALID_LIMA_VM_MEMORY_OPTIONS.map((v) => ({ value: v, label: MEMORY_LABELS[v] || v })),
      defaultValue: DEFAULT_LIMA_VM_MEMORY,
    },
  ],
}

export function RuntimeTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const startRunner = useStartRunner()
  const restartRunner = useRestartRunner()
  const refreshAvailability = useRefreshAvailability()

  // Local form state — main settings
  const [containerRunner, setContainerRunner] = useState('')
  const [agentImage, setAgentImage] = useState('')
  const [cpuLimit, setCpuLimit] = useState('')
  const [memoryLimit, setMemoryLimit] = useState('')
  const [autoSleepMinutes, setAutoSleepMinutes] = useState<string | null>(null)
  const [maxOutputTokens, setMaxOutputTokens] = useState<string | null>(null)
  const [maxThinkingTokens, setMaxThinkingTokens] = useState<string | null>(null)
  const [maxTurns, setMaxTurns] = useState<string | null>(null)
  const [maxBudgetUsd, setMaxBudgetUsd] = useState<string | null>(null)
  const [customEnvVarsDraft, setCustomEnvVarsDraft] = useState<Record<string, string>>({})
  const [isAddEnvDialogOpen, setIsAddEnvDialogOpen] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')
  const [newEnvValue, setNewEnvValue] = useState('')
  const [customEnvError, setCustomEnvError] = useState<string | null>(null)
  const [dialogEnvError, setDialogEnvError] = useState<string | null>(null)

  // Local form state — runtime-specific settings (keyed by field key)
  const [runtimeSettingsForm, setRuntimeSettingsForm] = useState<Record<string, string>>({})

  // Track if form has unsaved changes
  const [hasChanges, setHasChanges] = useState(false)

  // Get saved runtime settings for the current runner
  const savedRuntimeSettings = useMemo(
    () => settings?.container.runtimeSettings?.[containerRunner] ?? {},
    [settings, containerRunner]
  )

  // Get the field definitions for the current runner
  const currentRunnerFields = useMemo(
    () => RUNTIME_SETTINGS[containerRunner] ?? [],
    [containerRunner]
  )

  // Sizing guardrail for the built-in runtime's VM memory: options at or above
  // the machine's physical RAM are disabled (the server refuses them too), and
  // picks above half of it get an inline warning — that configuration starves
  // the host and gets agents OOM-killed mid-turn.
  const hostTotalMemoryBytes = settings?.hostTotalMemoryBytes
  const assessVmMemoryOption = (value: string) =>
    hostTotalMemoryBytes ? assessVmMemory(value, hostTotalMemoryBytes) : ({ level: 'ok' } as const)
  const vmMemoryAssessment = useMemo(() => {
    const selected = runtimeSettingsForm.vmMemory
    if (!selected || !hostTotalMemoryBytes) return { level: 'ok' } as const
    return assessVmMemory(selected, hostTotalMemoryBytes)
  }, [runtimeSettingsForm.vmMemory, hostTotalMemoryBytes])

  // Check if runtime-specific settings have changed
  const runtimeSettingsChanged = useMemo(() => {
    return currentRunnerFields.some((field) => {
      const saved = savedRuntimeSettings[field.key] || field.defaultValue
      const current = runtimeSettingsForm[field.key] || field.defaultValue
      return saved !== current
    })
  }, [currentRunnerFields, savedRuntimeSettings, runtimeSettingsForm])

  // Compute runner availability map with detailed status
  const runnerAvailabilityMap = useMemo(() => {
    const map = new Map<string, { installed: boolean; running: boolean; available: boolean; canStart: boolean; supportsCustomAgentImage: boolean }>()
    settings?.runnerAvailability?.forEach((r) => {
      map.set(r.runner, {
        installed: r.installed,
        running: r.running,
        available: r.available,
        canStart: r.canStart,
        supportsCustomAgentImage: r.supportsCustomAgentImage ?? true,
      })
    })
    return map
  }, [settings?.runnerAvailability])

  // Runners whose image is fixed by the deployment (e.g. lambda-microvm) ignore
  // settings.container.agentImage — lock the field so edits aren't misleading.
  const agentImageLocked =
    runnerAvailabilityMap.get(containerRunner)?.supportsCustomAgentImage === false

  const noRunnersAvailable = useMemo(() => {
    if (!settings?.runnerAvailability) return false
    return settings.runnerAvailability.every((r) => !r.available)
  }, [settings?.runnerAvailability])

  // Check if any runner can be started or first-installed via startRunner
  const hasStartableRunner = useMemo(() => {
    if (!settings?.runnerAvailability) return false
    return settings.runnerAvailability.some((r) => !r.running && r.canStart)
  }, [settings?.runnerAvailability])

  // Derive runner list from server-reported availability (only shows eligible runners)
  const containerRunners = useMemo(() => {
    if (!settings?.runnerAvailability) {
      return [{ value: 'docker', label: 'Docker' }]
    }
    return settings.runnerAvailability.map((r) => ({
      value: r.runner,
      label: RUNNER_LABELS[r.runner] || r.runner,
    }))
  }, [settings?.runnerAvailability])

  // Sync each persisted field from its primitive value so availability-only
  // settings refetches do not reset an in-progress dropdown selection.
  useEffect(() => {
    if (!settings) return
    setContainerRunner(settings.container.containerRunner)
  }, [settings?.container.containerRunner])

  useEffect(() => {
    if (!settings) return
    setAgentImage(settings.container.agentImage)
    setCpuLimit(settings.container.resourceLimits.cpu.toString())
    setMemoryLimit(settings.container.resourceLimits.memory)
    setAutoSleepMinutes(null)
  }, [
    settings?.container.agentImage,
    settings?.container.resourceLimits.cpu,
    settings?.container.resourceLimits.memory,
  ])

  useEffect(() => {
    if (!settings || updateSettings.isPending) return
    setCustomEnvVarsDraft(settings.customEnvVars ?? {})
  }, [settings?.customEnvVars, updateSettings.isPending])

  // Initialize runtime settings form when runner changes or settings load
  useEffect(() => {
    if (!settings || !containerRunner) return
    const saved = settings.container.runtimeSettings?.[containerRunner] ?? {}
    const fields = RUNTIME_SETTINGS[containerRunner] ?? []
    const form: Record<string, string> = {}
    for (const field of fields) {
      form[field.key] = saved[field.key] || field.defaultValue
    }
    setRuntimeSettingsForm(form)
  }, [containerRunner, settings?.container.runtimeSettings])

  // Check for changes (main settings only — runtime settings have their own save)
  useEffect(() => {
    if (!settings || !containerRunner) return

    const changed =
      containerRunner !== settings.container.containerRunner ||
      (!agentImageLocked && agentImage !== settings.container.agentImage) ||
      cpuLimit !== settings.container.resourceLimits.cpu.toString() ||
      memoryLimit !== settings.container.resourceLimits.memory

    setHasChanges(changed)
  }, [containerRunner, agentImage, cpuLimit, memoryLimit, settings, agentImageLocked])

  const latestAgentImage = getDefaultAgentImage()
  const trimmedAgentImage = agentImage.trim()
  const agentImageMissing = !agentImageLocked && trimmedAgentImage.length === 0
  const isLatestAgentImage = trimmedAgentImage === latestAgentImage

  const handleStartRunner = async (runner: string) => {
    startRunner.reset()
    try {
      await startRunner.mutateAsync(runner)
      setContainerRunner(runner)
    } catch (error) {
      console.error('Failed to start runner:', error)
    }
  }

  const handleSave = async () => {
    if (agentImageMissing) return
    try {
      await updateSettings.mutateAsync({
        container: {
          containerRunner,
          // A locked field never submits edits — keep whatever is persisted.
          agentImage: agentImageLocked
            ? (settings?.container.agentImage ?? trimmedAgentImage)
            : trimmedAgentImage,
          resourceLimits: {
            cpu: parseInt(cpuLimit, 10) || 1,
            memory: memoryLimit,
          },
        },
      })
    } catch (error) {
      console.error('Failed to save settings:', error)
    }
  }

  const handleReset = () => {
    if (settings) {
      setContainerRunner(settings.container.containerRunner)
      setAgentImage(settings.container.agentImage)
      setCpuLimit(settings.container.resourceLimits.cpu.toString())
      setMemoryLimit(settings.container.resourceLimits.memory)
    }
  }

  const persistCustomEnvVars = async (updated: Record<string, string>) => {
    // Remember the last-good draft so a rejected save can be rolled back instead
    // of leaving the bad value on screen as if it had saved (SUP-239 bug 1).
    const previous = customEnvVarsDraft
    setCustomEnvVarsDraft(updated)

    // Mirror the server-side reserved-runtime-var guard (SUP-210) client-side so
    // the rejection is instant and the offending row never lingers.
    const reserved = findReservedEnvVarKeys(updated)
    if (reserved.length > 0) {
      setCustomEnvVarsDraft(previous)
      setCustomEnvError(
        `customEnvVars may not override reserved runtime variables: ${reserved.join(', ')}`
      )
      return
    }

    setCustomEnvError(null)
    try {
      await updateSettings.mutateAsync({ customEnvVars: updated })
    } catch (error) {
      // The server did not persist (e.g. 400) — revert so the draft reflects
      // what is actually saved rather than the rejected value.
      setCustomEnvVarsDraft(previous)
      const message =
        error && typeof error === 'object' && 'error' in error && typeof error.error === 'string'
          ? error.error
          : 'Failed to save custom environment variables'
      setCustomEnvError(message)
      console.error('Failed to save custom env vars:', error)
    }
  }

  const handleAddCustomEnvVar = async () => {
    const envName = normalizeEnvVarName(newEnvName)
    if (!envName) {
      setDialogEnvError('Environment variable name is required.')
      return
    }
    if (envName in customEnvVarsDraft) {
      setDialogEnvError('That environment variable already exists.')
      return
    }

    await persistCustomEnvVars({ ...customEnvVarsDraft, [envName]: newEnvValue })
    setNewEnvName('')
    setNewEnvValue('')
    setIsAddEnvDialogOpen(false)
  }

  // Save runtime-specific settings and restart the runtime
  const handleSaveRuntimeSettings = async () => {
    try {
      // Save the settings first
      await updateSettings.mutateAsync({
        container: {
          ...settings?.container,
          runtimeSettings: {
            ...settings?.container.runtimeSettings,
            [containerRunner]: runtimeSettingsForm,
          },
        },
      })
      // Restart the runtime so changes take effect
      await restartRunner.mutateAsync(containerRunner)
    } catch (error) {
      console.error('Failed to save runtime settings:', error)
    }
  }

  const handleResetRuntimeSettings = () => {
    const saved = settings?.container.runtimeSettings?.[containerRunner] ?? {}
    const fields = RUNTIME_SETTINGS[containerRunner] ?? []
    const form: Record<string, string> = {}
    for (const field of fields) {
      form[field.key] = saved[field.key] || field.defaultValue
    }
    setRuntimeSettingsForm(form)
  }

  const hasRunningAgents = settings?.hasRunningAgents ?? false

  // Check if restricted fields have changed
  const restrictedFieldsChanged =
    settings &&
    (containerRunner !== settings.container.containerRunner ||
     cpuLimit !== settings.container.resourceLimits.cpu.toString() ||
     memoryLimit !== settings.container.resourceLimits.memory)

  const saveBlocked = hasRunningAgents && restrictedFieldsChanged
  const runtimeSaveBlocked = hasRunningAgents
  const isRestarting = restartRunner.isPending || updateSettings.isPending

  return (
    <div className="space-y-6">
      {/* No runners available warning */}
      {noRunnersAvailable && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>No Container Runtime Available</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>No container runtime was detected as running on your system.</p>
            {hasStartableRunner && (
              <div className="flex gap-2 mt-2">
                {settings?.runnerAvailability
                  ?.filter((r) => !r.running && r.canStart)
                  .map((r) => (
                    <Button
                      key={r.runner}
                      size="sm"
                      variant="outline"
                      onClick={() => handleStartRunner(r.runner)}
                      disabled={startRunner.isPending}
                    >
                      {startRunner.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : r.installed ? (
                        <Play className="h-4 w-4 mr-2" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      {r.installed ? 'Start' : 'Install'}{' '}
                      {RUNNER_LABELS[r.runner] || r.runner.charAt(0).toUpperCase() + r.runner.slice(1)}
                    </Button>
                  ))}
              </div>
            )}
            {!hasStartableRunner && (
              <p className="text-xs">Please install a container runtime to use Gamut.</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Image pull / runtime install progress */}
      {(settings?.runtimeReadiness?.status === 'PULLING_IMAGE' ||
        (settings?.runtimeReadiness?.status === 'CHECKING' && settings.runtimeReadiness.pullProgress)) && (
        <Alert>
          <Loader2 className="h-4 w-4 animate-spin" />
          <AlertTitle>
            {settings.runtimeReadiness.status === 'PULLING_IMAGE' ? 'Pulling Agent Image' : 'Setting Up Runtime'}
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <RuntimeProvisionProgress
              progress={
                settings.runtimeReadiness.pullProgress ?? {
                  status: settings.runtimeReadiness.message || 'Working...',
                  percent: null,
                }
              }
            />
          </AlertDescription>
        </Alert>
      )}

      {/* Image pull error */}
      {settings?.runtimeReadiness?.status === 'ERROR' && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Image Pull Failed</AlertTitle>
          <AlertDescription>{settings.runtimeReadiness.message}</AlertDescription>
        </Alert>
      )}

      {hasRunningAgents && (
        <div className="flex items-start gap-2 p-3 text-sm bg-yellow-500/10 border border-yellow-500/20 rounded-md">
          <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
          <p className="text-yellow-700 dark:text-yellow-400">
            Some settings cannot be changed while agents are running. Stop all agents to modify container runtime or resource limits.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="container-runner">Container Runtime</Label>
        <div className="flex gap-2">
          <Select
            value={containerRunner}
            onValueChange={setContainerRunner}
            disabled={isLoading || hasRunningAgents}
          >
            <SelectTrigger id="container-runner" className={`flex-1 ${hasRunningAgents ? 'bg-muted' : ''}`}>
              <SelectValue placeholder="Select a container runtime" />
            </SelectTrigger>
            <SelectContent>
              {containerRunners.map((runner) => {
                const status = runnerAvailabilityMap.get(runner.value)
                const isAvailable = status?.available ?? true
                const isInstalled = status?.installed ?? true
                const canStart = status?.canStart ?? false
                const isSelectable = isAvailable || canStart

                let statusText = ''
                if (!isInstalled) {
                  statusText = ' (not installed)'
                } else if (!isAvailable && !canStart) {
                  statusText = ' (not running)'
                }

                return (
                  <SelectItem
                    key={runner.value}
                    value={runner.value}
                    disabled={!isSelectable}
                    className={!isSelectable ? 'opacity-50' : ''}
                  >
                    {runner.label}
                    {statusText}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {/* Show start/install when selected runner canStart (incl. apple first-install) */}
          {!runnerAvailabilityMap.get(containerRunner)?.running &&
            runnerAvailabilityMap.get(containerRunner)?.canStart && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => handleStartRunner(containerRunner)}
              disabled={startRunner.isPending}
              title={
                runnerAvailabilityMap.get(containerRunner)?.installed
                  ? `Start ${containerRunner}`
                  : `Install ${containerRunner}`
              }
            >
              {startRunner.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : runnerAvailabilityMap.get(containerRunner)?.installed ? (
                <Play className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refreshAvailability.mutate()}
            disabled={refreshAvailability.isPending}
            title="Refresh runtime availability"
          >
            <RefreshCw className={`h-4 w-4 ${refreshAvailability.isPending ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The container runtime to use for running agents.
          {containerRunners.some(r => r.value === 'wsl2') &&
            !runnerAvailabilityMap.get('wsl2')?.installed && (
            <span className="text-yellow-600 dark:text-yellow-400 block mt-1">
              WSL2 is not installed. Run <code className="bg-muted px-1 rounded">wsl --install</code> in PowerShell as Administrator, then restart your computer.
            </span>
          )}
          {restartRunner.isPending && (
            <span className="text-yellow-600 dark:text-yellow-400 block mt-1 flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin inline" />
              Restarting {RUNNER_LABELS[containerRunner] || containerRunner}...
            </span>
          )}
          {startRunner.displayError && getRunnerSetupPayload(startRunner.displayError) ? (
            <div className="mt-2">
              <RunnerSetupErrorPanel error={startRunner.displayError} />
            </div>
          ) : startRunner.displayError ? (
            <span className="text-destructive block mt-1">
              {startRunner.displayError.message}
            </span>
          ) : null}
          {startRunner.isSuccess && startRunner.data?.message && !startRunner.displayError && (
            <span className="text-green-600 dark:text-green-400 block mt-1">
              {startRunner.data.message}
            </span>
          )}
        </p>
      </div>

      {/* Runtime-specific settings */}
      {currentRunnerFields.length > 0 && (
        <div className="space-y-4 p-4 border rounded-md">
          <div className="space-y-0.5">
            <Label className="text-base">{RUNNER_LABELS[containerRunner] || containerRunner} Settings</Label>
            <p className="text-xs text-muted-foreground">
              Changing these settings will restart the runtime.
            </p>
          </div>

          {currentRunnerFields.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={`runtime-${field.key}`}>{field.label}</Label>
              {field.type === 'select' && field.options ? (
                <Select
                  value={runtimeSettingsForm[field.key] || field.defaultValue}
                  onValueChange={(value) =>
                    setRuntimeSettingsForm((prev) => ({ ...prev, [field.key]: value }))
                  }
                  disabled={isLoading || runtimeSaveBlocked || isRestarting}
                >
                  <SelectTrigger id={`runtime-${field.key}`} className={runtimeSaveBlocked ? 'bg-muted' : ''}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((opt) => {
                      const oversized =
                        field.key === 'vmMemory' && assessVmMemoryOption(opt.value).level === 'refuse'
                      return (
                        <SelectItem key={opt.value} value={opt.value} disabled={oversized}>
                          {opt.label}
                          {oversized ? ' (exceeds system memory)' : ''}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`runtime-${field.key}`}
                  value={runtimeSettingsForm[field.key] || ''}
                  onChange={(e) =>
                    setRuntimeSettingsForm((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  disabled={isLoading || runtimeSaveBlocked || isRestarting}
                  className={runtimeSaveBlocked ? 'bg-muted' : ''}
                />
              )}
              <p className="text-xs text-muted-foreground">{field.description}</p>
              {field.key === 'vmMemory' && vmMemoryAssessment.level === 'warn' && (
                <p className="text-xs text-yellow-600 dark:text-yellow-400">
                  {vmMemoryAssessment.message}
                </p>
              )}
              {field.key === 'vmMemory' && vmMemoryAssessment.level === 'refuse' && (
                <p className="text-xs text-destructive">{vmMemoryAssessment.message}</p>
              )}
            </div>
          ))}

          {runtimeSettingsChanged && (
            <div className="flex items-center justify-end gap-2 pt-2 border-t">
              {restartRunner.error && getRunnerSetupPayload(restartRunner.error) ? (
                <div className="mr-auto w-full">
                  <RunnerSetupErrorPanel error={restartRunner.error} />
                </div>
              ) : restartRunner.error ? (
                <p className="text-sm text-destructive mr-auto">
                  {restartRunner.error.message}
                </p>
              ) : null}
              {restartRunner.isSuccess && restartRunner.data?.message && (
                <p className="text-sm text-green-600 dark:text-green-400 mr-auto">
                  {restartRunner.data.message}
                </p>
              )}
              <Button
                variant="outline"
                onClick={handleResetRuntimeSettings}
                disabled={isRestarting}
              >
                Reset
              </Button>
              <Button
                onClick={handleSaveRuntimeSettings}
                disabled={isRestarting || runtimeSaveBlocked || vmMemoryAssessment.level === 'refuse'}
              >
                {isRestarting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Restarting...
                  </>
                ) : (
                  'Save & Restart'
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="agent-image">Agent Image</Label>
        <Input
          id="agent-image"
          value={agentImage}
          onChange={(e) => setAgentImage(e.target.value)}
          placeholder="ghcr.io/skillfulagents/superagent-agent-container-base:latest"
          disabled={isLoading || agentImageLocked}
          className={agentImageLocked ? 'bg-muted' : ''}
        />
        <p className="text-xs text-muted-foreground">
          {agentImageLocked
            ? 'Agent image is managed by the deployment for this runner and cannot be changed here.'
            : 'Docker image to use for agent containers.'}
        </p>
        {!agentImageLocked && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 text-xs"
            onClick={() => setAgentImage(latestAgentImage)}
            disabled={isLoading || isLatestAgentImage}
          >
            Use default
          </Button>
        )}
        {agentImageMissing && (
          <p className="text-xs text-destructive">Agent image is required.</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="cpu-limit">CPU Limit</Label>
          <Select
            value={cpuLimit}
            onValueChange={setCpuLimit}
            disabled={isLoading || hasRunningAgents}
          >
            <SelectTrigger
              id="cpu-limit"
              className={hasRunningAgents ? 'bg-muted' : ''}
            >
              <SelectValue placeholder="Select CPU cores" />
            </SelectTrigger>
            <SelectContent>
              {(CPU_LIMIT_OPTIONS.map(String).includes(cpuLimit)
                ? CPU_LIMIT_OPTIONS.map(String)
                : cpuLimit
                  ? [cpuLimit, ...CPU_LIMIT_OPTIONS.map(String)]
                  : CPU_LIMIT_OPTIONS.map(String)
              ).map((v) => (
                <SelectItem key={v} value={v}>
                  {v} {v === '1' ? 'core' : 'cores'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Number of CPU cores.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="memory-limit">Memory Limit</Label>
          <Select
            value={memoryLimit}
            onValueChange={setMemoryLimit}
            disabled={isLoading || hasRunningAgents}
          >
            <SelectTrigger
              id="memory-limit"
              className={hasRunningAgents ? 'bg-muted' : ''}
            >
              <SelectValue placeholder="Select memory limit" />
            </SelectTrigger>
            <SelectContent>
              {(MEMORY_LIMIT_OPTIONS.some((o) => o.value === memoryLimit) || !memoryLimit
                ? MEMORY_LIMIT_OPTIONS
                : [{ value: memoryLimit, label: memoryLimit }, ...MEMORY_LIMIT_OPTIONS]
              ).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Maximum memory available to each agent container.
          </p>
        </div>
      </div>

      {/* Auto-Sleep Idle Containers */}
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label htmlFor="auto-sleep-timeout">Idle Timeout</Label>
          <p className="text-xs text-muted-foreground">
            Automatically stop containers after being idle for this duration. Set to 0 to disable.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id="auto-sleep-timeout"
            type="number"
            min={0}
            step={1}
            value={autoSleepMinutes ?? (settings?.app?.autoSleepTimeoutMinutes ?? 30).toString()}
            onChange={(e) => setAutoSleepMinutes(e.target.value)}
            onBlur={() => {
              const value = Math.max(0, parseInt(autoSleepMinutes ?? '30', 10) || 0)
              setAutoSleepMinutes(null)
              updateSettings.mutate({ app: { autoSleepTimeoutMinutes: value } })
            }}
            className="w-24"
            disabled={isLoading}
          />
          <span className="text-sm text-muted-foreground">minutes</span>
        </div>
      </div>

      {/* Agent Limits */}
      <div className="space-y-4 pt-2">
        <div className="space-y-0.5">
          <Label className="text-base">Agent Limits</Label>
          <p className="text-xs text-muted-foreground">
            Configure limits for agent sessions. Leave empty to use defaults.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="max-output-tokens">Max Output Tokens</Label>
            <Input
              id="max-output-tokens"
              type="number"
              min={1024}
              step={1024}
              value={maxOutputTokens ?? (settings?.agentLimits?.maxOutputTokens?.toString() || '')}
              onChange={(e) => setMaxOutputTokens(e.target.value)}
              onBlur={() => {
                const raw = maxOutputTokens
                setMaxOutputTokens(null)
                if (raw === null) return
                const parsed = parseInt(raw, 10)
                const value = raw === '' ? undefined : (isNaN(parsed) ? undefined : Math.max(1024, parsed))
                updateSettings.mutate({ agentLimits: { maxOutputTokens: value } })
              }}
              placeholder="32000"
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Max tokens per model response. Default: 32,000.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-thinking-tokens">Max Thinking Tokens</Label>
            <Input
              id="max-thinking-tokens"
              type="number"
              min={1024}
              step={1024}
              value={maxThinkingTokens ?? (settings?.agentLimits?.maxThinkingTokens?.toString() || '')}
              onChange={(e) => setMaxThinkingTokens(e.target.value)}
              onBlur={() => {
                const raw = maxThinkingTokens
                setMaxThinkingTokens(null)
                if (raw === null) return
                const parsed = parseInt(raw, 10)
                const value = raw === '' ? undefined : (isNaN(parsed) ? undefined : Math.max(1024, parsed))
                updateSettings.mutate({ agentLimits: { maxThinkingTokens: value } })
              }}
              placeholder="Unlimited"
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Max tokens for extended thinking/reasoning.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-turns">Max Turns</Label>
            <Input
              id="max-turns"
              type="number"
              min={1}
              step={1}
              value={maxTurns ?? (settings?.agentLimits?.maxTurns?.toString() || '')}
              onChange={(e) => setMaxTurns(e.target.value)}
              onBlur={() => {
                const raw = maxTurns
                setMaxTurns(null)
                if (raw === null) return
                const parsed = parseInt(raw, 10)
                const value = raw === '' ? undefined : (isNaN(parsed) ? undefined : Math.max(1, parsed))
                updateSettings.mutate({ agentLimits: { maxTurns: value } })
              }}
              placeholder="Unlimited"
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Max conversation turns per session.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-budget-usd">Max Budget (USD)</Label>
            <Input
              id="max-budget-usd"
              type="number"
              min={0.01}
              step={0.01}
              value={maxBudgetUsd ?? (settings?.agentLimits?.maxBudgetUsd?.toString() || '')}
              onChange={(e) => setMaxBudgetUsd(e.target.value)}
              onBlur={() => {
                const raw = maxBudgetUsd
                setMaxBudgetUsd(null)
                if (raw === null) return
                const parsed = parseFloat(raw)
                const value = raw === '' ? undefined : (isNaN(parsed) ? undefined : Math.max(0.01, parsed))
                updateSettings.mutate({ agentLimits: { maxBudgetUsd: value } })
              }}
              placeholder="Unlimited"
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Maximum cost per session in USD.
            </p>
          </div>
        </div>
      </div>

      {/* Custom Environment Variables */}
      <div className="space-y-4 pt-2">
        <div className="space-y-0.5">
          <Label className="text-base">Custom Environment Variables</Label>
          <p className="text-xs text-muted-foreground">
            Set additional environment variables for the agent process. These are passed to the Claude Code CLI. Changes apply to new sessions.
          </p>
        </div>

        <div className="space-y-2">
          {Object.entries(customEnvVarsDraft).map(([key, value]) => (
            <div
              key={key}
              className="flex items-center gap-2"
              data-testid="custom-env-var-row"
              data-env-var-key={key}
            >
              <Input
                value={key}
                className="font-mono text-sm flex-[2]"
                disabled
                data-testid="custom-env-var-key"
              />
              <Input
                value={value}
                className="font-mono text-sm flex-[3]"
                maxLength={4096}
                onChange={(e) => {
                  setCustomEnvVarsDraft((prev) => ({ ...prev, [key]: e.target.value }))
                }}
                onBlur={(e) => {
                  const val = e.target.value
                  setCustomEnvVarsDraft((prev) => {
                    const updated = { ...prev, [key]: val }
                    persistCustomEnvVars(updated)
                    return updated
                  })
                }}
                disabled={isLoading || updateSettings.isPending}
                data-testid="custom-env-var-value"
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                data-testid="custom-env-var-delete"
                onClick={async () => {
                  const updated = { ...customEnvVarsDraft }
                  delete updated[key]
                  await persistCustomEnvVars(updated)
                }}
                disabled={isLoading || updateSettings.isPending}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}

          {customEnvError && (
            <p className="text-xs text-destructive">{customEnvError}</p>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAddEnvDialogOpen(true)}
            disabled={isLoading || updateSettings.isPending}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Variable
          </Button>
        </div>
      </div>

      <Dialog
        open={isAddEnvDialogOpen}
        onOpenChange={(open) => {
          setIsAddEnvDialogOpen(open)
          if (!open) {
            setNewEnvName('')
            setNewEnvValue('')
            setDialogEnvError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Custom Environment Variable</DialogTitle>
            <DialogDescription>
              These variables are passed to the agent process for new sessions.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={(e) => { e.preventDefault(); handleAddCustomEnvVar() }}>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="custom-env-name">Variable Name</Label>
                <Input
                  id="custom-env-name"
                  value={newEnvName}
                  onChange={(e) => { setNewEnvName(e.target.value); setDialogEnvError(null) }}
                  placeholder="CLAUDE_CODE_MAX_OUTPUT_TOKENS"
                  className="font-mono text-sm"
                  maxLength={256}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="custom-env-value">Value</Label>
                <Input
                  id="custom-env-value"
                  value={newEnvValue}
                  onChange={(e) => setNewEnvValue(e.target.value)}
                  placeholder="32000"
                  className="font-mono text-sm"
                  maxLength={4096}
                />
              </div>

              {dialogEnvError && (
                <p className="text-xs text-destructive">{dialogEnvError}</p>
              )}
            </div>

            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsAddEnvDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isLoading || updateSettings.isPending}
              >
                Add Variable
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Data Location - Read Only */}
      <div className="space-y-2">
        <Label htmlFor="data-location">Data Location</Label>
        <Input
          id="data-location"
          value={isLoading ? 'Loading...' : settings?.dataDir ?? ''}
          readOnly
          className="bg-muted"
        />
        <p className="text-xs text-muted-foreground">
          Configure via <code className="bg-muted px-1 rounded">SUPERAGENT_DATA_DIR</code> environment variable.
        </p>
      </div>

      {/* Save/Reset buttons — main settings only */}
      {hasChanges && (
        <div className="flex items-center justify-end gap-2 pt-4 border-t">
          {updateSettings.error && (
            <p className="text-sm text-destructive mr-auto">
              {updateSettings.error.error}
            </p>
          )}
          <Button variant="outline" onClick={handleReset} disabled={updateSettings.isPending}>
            Reset
          </Button>
          <Button
            onClick={handleSave}
            disabled={updateSettings.isPending || saveBlocked || agentImageMissing}
          >
            {updateSettings.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  )
}
