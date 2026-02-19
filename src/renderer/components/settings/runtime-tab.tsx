import { useState, useEffect, useMemo } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings, useStartRunner, useRefreshAvailability } from '@renderer/hooks/use-settings'
import { AlertCircle, AlertTriangle, Play, Loader2, RefreshCw, Plus, X } from 'lucide-react'

const MIN_MEMORY_BYTES = 512 * 1024 * 1024 // 512 MiB

/** Parse Docker memory string (e.g., "512m", "2g") to bytes. Returns 0 if invalid. */
function parseMemoryToBytes(value: string): number {
  const match = value.trim().match(/^([\d.]+)\s*([kmg])$/i)
  if (!match) return 0
  const num = parseFloat(match[1])
  const unit = match[2].toLowerCase()
  const multipliers: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
  return Math.round(num * (multipliers[unit] || 1))
}

const RUNNER_LABELS: Record<string, string> = {
  'apple-container': 'macOS Container',
  docker: 'Docker',
  podman: 'Podman',
}

export function RuntimeTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const startRunner = useStartRunner()
  const refreshAvailability = useRefreshAvailability()

  // Local form state
  const [containerRunner, setContainerRunner] = useState('')
  const [agentImage, setAgentImage] = useState('')
  const [cpuLimit, setCpuLimit] = useState('')
  const [memoryLimit, setMemoryLimit] = useState('')
  const [autoSleepMinutes, setAutoSleepMinutes] = useState<string | null>(null)
  const [maxOutputTokens, setMaxOutputTokens] = useState<string | null>(null)
  const [maxThinkingTokens, setMaxThinkingTokens] = useState<string | null>(null)
  const [maxTurns, setMaxTurns] = useState<string | null>(null)
  const [maxBudgetUsd, setMaxBudgetUsd] = useState<string | null>(null)

  // Track if form has unsaved changes
  const [hasChanges, setHasChanges] = useState(false)

  // Compute runner availability map with detailed status
  const runnerAvailabilityMap = useMemo(() => {
    const map = new Map<string, { installed: boolean; running: boolean; available: boolean; canStart: boolean }>()
    settings?.runnerAvailability?.forEach((r) => {
      map.set(r.runner, {
        installed: r.installed,
        running: r.running,
        available: r.available,
        canStart: r.canStart,
      })
    })
    return map
  }, [settings?.runnerAvailability])

  const noRunnersAvailable = useMemo(() => {
    if (!settings?.runnerAvailability) return false
    return settings.runnerAvailability.every((r) => !r.available)
  }, [settings?.runnerAvailability])

  // Check if any runner is installed but not running
  const hasStartableRunner = useMemo(() => {
    if (!settings?.runnerAvailability) return false
    return settings.runnerAvailability.some((r) => r.installed && !r.running && r.canStart)
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

  const handleStartRunner = async (runner: string) => {
    try {
      await startRunner.mutateAsync(runner)
    } catch (error) {
      console.error('Failed to start runner:', error)
    }
  }

  // Initialize form values when settings load
  useEffect(() => {
    if (settings) {
      setContainerRunner(settings.container.containerRunner)
      setAgentImage(settings.container.agentImage)
      setCpuLimit(settings.container.resourceLimits.cpu.toString())
      setMemoryLimit(settings.container.resourceLimits.memory)
      setHasChanges(false)
      setAutoSleepMinutes(null)
    }
  }, [settings])

  // Check for changes
  useEffect(() => {
    if (!settings) return

    const changed =
      containerRunner !== settings.container.containerRunner ||
      agentImage !== settings.container.agentImage ||
      cpuLimit !== settings.container.resourceLimits.cpu.toString() ||
      memoryLimit !== settings.container.resourceLimits.memory

    setHasChanges(changed)
  }, [containerRunner, agentImage, cpuLimit, memoryLimit, settings])

  const memoryTooLow = parseMemoryToBytes(memoryLimit) > 0 && parseMemoryToBytes(memoryLimit) < MIN_MEMORY_BYTES

  const handleSave = async () => {
    if (memoryTooLow) return
    try {
      await updateSettings.mutateAsync({
        container: {
          containerRunner,
          agentImage,
          resourceLimits: {
            cpu: parseFloat(cpuLimit) || 1,
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

  const hasRunningAgents = settings?.hasRunningAgents ?? false

  // Check if restricted fields have changed
  const restrictedFieldsChanged =
    settings &&
    (containerRunner !== settings.container.containerRunner ||
     cpuLimit !== settings.container.resourceLimits.cpu.toString() ||
     memoryLimit !== settings.container.resourceLimits.memory)

  const saveBlocked = hasRunningAgents && restrictedFieldsChanged

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
                  ?.filter((r) => r.installed && !r.running && r.canStart)
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
                      ) : (
                        <Play className="h-4 w-4 mr-2" />
                      )}
                      Start {r.runner.charAt(0).toUpperCase() + r.runner.slice(1)}
                    </Button>
                  ))}
              </div>
            )}
            {!hasStartableRunner && (
              <p className="text-xs">Please install a container runtime to use Superagent.</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Image pull progress */}
      {settings?.runtimeReadiness?.status === 'PULLING_IMAGE' && (
        <Alert>
          <Loader2 className="h-4 w-4 animate-spin" />
          <AlertTitle>Pulling Agent Image</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{settings.runtimeReadiness.pullProgress?.status || 'Downloading...'}</p>
            {settings.runtimeReadiness.pullProgress?.percent != null && (
              <div className="mt-2 h-2 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${settings.runtimeReadiness.pullProgress.percent}%` }}
                />
              </div>
            )}
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
            Some settings cannot be changed while agents are running. Stop all agents to modify container runner or resource limits.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="container-runner">Container Runner</Label>
        <div className="flex gap-2">
          <Select
            value={containerRunner}
            onValueChange={setContainerRunner}
            disabled={isLoading || hasRunningAgents}
          >
            <SelectTrigger id="container-runner" className={`flex-1 ${hasRunningAgents ? 'bg-muted' : ''}`}>
              <SelectValue placeholder="Select a container runner" />
            </SelectTrigger>
            <SelectContent>
              {containerRunners.map((runner) => {
                const status = runnerAvailabilityMap.get(runner.value)
                const isAvailable = status?.available ?? true
                const isInstalled = status?.installed ?? true

                let statusText = ''
                if (!isInstalled) {
                  statusText = ' (not installed)'
                } else if (!isAvailable) {
                  statusText = ' (not running)'
                }

                return (
                  <SelectItem
                    key={runner.value}
                    value={runner.value}
                    disabled={!isAvailable}
                    className={!isAvailable ? 'opacity-50' : ''}
                  >
                    {runner.label}
                    {statusText}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {/* Show start button if selected runner is installed but not running */}
          {runnerAvailabilityMap.get(containerRunner)?.installed &&
            !runnerAvailabilityMap.get(containerRunner)?.running &&
            runnerAvailabilityMap.get(containerRunner)?.canStart && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => handleStartRunner(containerRunner)}
              disabled={startRunner.isPending}
              title={`Start ${containerRunner}`}
            >
              {startRunner.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
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
          {startRunner.error && (
            <span className="text-destructive block mt-1">
              {startRunner.error.message}
            </span>
          )}
          {startRunner.isSuccess && startRunner.data?.message && (
            <span className="text-green-600 dark:text-green-400 block mt-1">
              {startRunner.data.message}
            </span>
          )}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="agent-image">Agent Image</Label>
        <Input
          id="agent-image"
          value={agentImage}
          onChange={(e) => setAgentImage(e.target.value)}
          placeholder="ghcr.io/skilfulagents/superagent-agent-container-base:main"
          disabled={isLoading}
        />
        <p className="text-xs text-muted-foreground">
          Docker image to use for agent containers.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="cpu-limit">CPU Limit</Label>
          <Input
            id="cpu-limit"
            type="number"
            min="0.1"
            step="0.1"
            value={cpuLimit}
            onChange={(e) => setCpuLimit(e.target.value)}
            placeholder="1"
            disabled={isLoading || hasRunningAgents}
            className={hasRunningAgents ? 'bg-muted' : ''}
          />
          <p className="text-xs text-muted-foreground">
            Number of CPU cores.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="memory-limit">Memory Limit</Label>
          <Input
            id="memory-limit"
            value={memoryLimit}
            onChange={(e) => setMemoryLimit(e.target.value)}
            placeholder="512m"
            disabled={isLoading || hasRunningAgents}
            className={hasRunningAgents ? 'bg-muted' : ''}
          />
          <p className="text-xs text-muted-foreground">
            Memory limit (e.g., 512m, 1g). Minimum 512m.
          </p>
          {memoryTooLow && (
            <p className="text-xs text-destructive">Memory limit must be at least 512m.</p>
          )}
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
          {Object.entries(settings?.customEnvVars ?? {}).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2">
              <Input
                value={key}
                className="font-mono text-sm flex-[2]"
                disabled
              />
              <Input
                value={value}
                className="font-mono text-sm flex-[3]"
                onChange={(e) => {
                  const updated = { ...settings?.customEnvVars, [key]: e.target.value }
                  updateSettings.mutate({ customEnvVars: updated })
                }}
                onBlur={(e) => {
                  const updated = { ...settings?.customEnvVars, [key]: e.target.value }
                  updateSettings.mutate({ customEnvVars: updated })
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => {
                  const updated = { ...settings?.customEnvVars }
                  delete updated[key]
                  updateSettings.mutate({ customEnvVars: updated })
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const name = prompt('Environment variable name (e.g., CLAUDE_CODE_MAX_OUTPUT_TOKENS):')
              if (!name?.trim()) return
              const envName = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
              const updated = { ...settings?.customEnvVars, [envName]: '' }
              updateSettings.mutate({ customEnvVars: updated })
            }}
            disabled={isLoading}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Variable
          </Button>
        </div>
      </div>

      {/* Save/Reset buttons */}
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
            disabled={updateSettings.isPending || saveBlocked || memoryTooLow}
          >
            {updateSettings.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  )
}
