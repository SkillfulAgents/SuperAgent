'use client'

import { useState, useEffect, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useSettings, useUpdateSettings } from '@/lib/hooks/use-settings'
import { AlertCircle, AlertTriangle } from 'lucide-react'

const CONTAINER_RUNNERS = [
  { value: 'docker', label: 'Docker' },
  { value: 'podman', label: 'Podman' },
]

export function GeneralTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  // Local form state
  const [containerRunner, setContainerRunner] = useState('')
  const [agentImage, setAgentImage] = useState('')
  const [cpuLimit, setCpuLimit] = useState('')
  const [memoryLimit, setMemoryLimit] = useState('')

  // Track if form has unsaved changes
  const [hasChanges, setHasChanges] = useState(false)

  // Compute runner availability map
  const runnerAvailability = useMemo(() => {
    const map = new Map<string, boolean>()
    settings?.runnerAvailability?.forEach((r) => {
      map.set(r.runner, r.available)
    })
    return map
  }, [settings?.runnerAvailability])

  const noRunnersAvailable = useMemo(() => {
    if (!settings?.runnerAvailability) return false
    return settings.runnerAvailability.every((r) => !r.available)
  }, [settings?.runnerAvailability])

  // Initialize form values when settings load
  useEffect(() => {
    if (settings) {
      setContainerRunner(settings.container.containerRunner)
      setAgentImage(settings.container.agentImage)
      setCpuLimit(settings.container.resourceLimits.cpu.toString())
      setMemoryLimit(settings.container.resourceLimits.memory)
      setHasChanges(false)
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

  const handleSave = async () => {
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
    } catch (error: any) {
      // Error is handled by the mutation
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
          <AlertDescription>
            Neither Docker nor Podman was detected on your system. Please install a container runtime to use Superagent.
          </AlertDescription>
        </Alert>
      )}

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

      {/* Container Settings */}
      <div className="pt-4 border-t space-y-4">
        <h3 className="text-sm font-medium">Container Settings</h3>

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
          <Select
            value={containerRunner}
            onValueChange={setContainerRunner}
            disabled={isLoading || hasRunningAgents}
          >
            <SelectTrigger id="container-runner" className={hasRunningAgents ? 'bg-muted' : ''}>
              <SelectValue placeholder="Select a container runner" />
            </SelectTrigger>
            <SelectContent>
              {CONTAINER_RUNNERS.map((runner) => {
                const isAvailable = runnerAvailability.get(runner.value) ?? true
                return (
                  <SelectItem
                    key={runner.value}
                    value={runner.value}
                    disabled={!isAvailable}
                    className={!isAvailable ? 'opacity-50' : ''}
                  >
                    {runner.label}
                    {!isAvailable && ' (not installed)'}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The container runtime to use for running agents.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="agent-image">Agent Image</Label>
          <Input
            id="agent-image"
            value={agentImage}
            onChange={(e) => setAgentImage(e.target.value)}
            placeholder="superagent-container:latest"
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
              Memory limit (e.g., 512m, 1g).
            </p>
          </div>
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
            disabled={updateSettings.isPending || saveBlocked}
          >
            {updateSettings.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  )
}
