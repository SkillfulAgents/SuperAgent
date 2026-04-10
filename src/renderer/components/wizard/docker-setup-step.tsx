import { useState, useMemo, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useSettings, useStartRunner, useRefreshAvailability } from '@renderer/hooks/use-settings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { getPlatform } from '@renderer/lib/env'
import { Wsl2InstallGuide } from './wsl2-install-guide'
import { RequestError } from '@renderer/components/messages/request-error'
import {
  Loader2,
  Check,
  Power,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react'

const RUNTIME_INFO: Record<string, { name: string; description: string; installUrl: string }> = {
  'apple-container': {
    name: 'macOS Container',
    description: 'Native container runtime built into macOS. Fast and lightweight with no extra software needed.',
    installUrl: 'https://github.com/apple/container',
  },
  docker: {
    name: 'Docker Desktop',
    description: 'The most popular third-party container runtime. Easy to use with a graphical interface.',
    installUrl: 'https://www.docker.com/products/docker-desktop/',
  },
  podman: {
    name: 'Podman',
    description: 'A lightweight, daemonless container engine. Great alternative to Docker for more technical users.',
    installUrl: 'https://podman.io/getting-started/installation',
  },
  lima: {
    name: 'Built-in Runtime',
    description: 'Bundled lightweight container runtime. No extra software needed — just works.',
    installUrl: '',
  },
  wsl2: {
    name: 'Built-in Runtime',
    description: 'Bundled lightweight container runtime using WSL2. No extra software needed — just works.',
    installUrl: 'https://learn.microsoft.com/en-us/windows/wsl/install',
  },
}

interface DockerSetupStepProps {
  onCanProceedChange?: (canProceed: boolean) => void
}

export function DockerSetupStep({ onCanProceedChange }: DockerSetupStepProps) {
  const { data: settings } = useSettings()
  const { data: runtimeStatus } = useRuntimeStatus()
  const startRunner = useStartRunner()
  const refreshAvailability = useRefreshAvailability()
  const [selectedRunner, setSelectedRunner] = useState<string | null>(null)
  const [showMoreOptions, setShowMoreOptions] = useState(false)

  // Detect if the built-in runtime (Lima on macOS, WSL2 on Windows) is actively starting
  const isBuiltinStarting = runtimeStatus?.runtimeReadiness?.status === 'CHECKING' &&
    runtimeStatus.runtimeReadiness.message?.toLowerCase().includes('built-in')

  const runtimeStatuses = useMemo(() => {
    if (!settings?.runnerAvailability) return []
    const statuses = settings.runnerAvailability.map((r) => ({
      ...r,
      info: RUNTIME_INFO[r.runner] || { name: r.runner, description: '', installUrl: '' },
      effectivelyAvailable: r.available || ((r.runner === 'lima' || r.runner === 'wsl2') && isBuiltinStarting),
    }))
    // Built-in runtime (lima/wsl2) should always appear first
    return statuses.sort((a, b) => {
      const aBuiltin = a.runner === 'lima' || a.runner === 'wsl2' ? 0 : 1
      const bBuiltin = b.runner === 'lima' || b.runner === 'wsl2' ? 0 : 1
      return aBuiltin - bBuiltin
    })
  }, [settings?.runnerAvailability, isBuiltinStarting])

  // Default selection: always prefer built-in runtime, then any available, then first in list
  const defaultRunner = useMemo(() => {
    return (
      runtimeStatuses.find((r) => r.runner === 'lima' || r.runner === 'wsl2')
      || runtimeStatuses.find((r) => r.effectivelyAvailable)
      || runtimeStatuses[0]
    )?.runner ?? null
  }, [runtimeStatuses])

  const effectiveSelected = selectedRunner ?? defaultRunner

  const isWindows = getPlatform() === 'win32'
  const wsl2Runtime = runtimeStatuses.find((r) => r.runner === 'wsl2')
  const showWsl2Guide = isWindows && wsl2Runtime && !wsl2Runtime.installed



  // Report to parent whether the selected runtime is available and running
  const selectedRuntime = runtimeStatuses.find((r) => r.runner === effectiveSelected)
  useEffect(() => {
    onCanProceedChange?.(selectedRuntime?.available ?? false)
  }, [selectedRuntime?.available, onCanProceedChange])

  const handleStartRunner = async (runner: string) => {
    try {
      await startRunner.mutateAsync(runner)
    } catch (error) {
      console.error('Failed to start runner:', error)
    }
  }

  const handleOpenInstallLink = (url: string) => {
    if (window.electronAPI) {
      window.electronAPI.openExternal(url)
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Set Up Container Runtime</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Superagent runs AI agents in isolated containers. You need a container runtime installed and running.
        </p>
      </div>


      <div className="space-y-3">
        {runtimeStatuses.map((runtime) => {
          const isBuiltin = runtime.runner === 'lima' || runtime.runner === 'wsl2'
          if (!isBuiltin && !showMoreOptions) return null

          const isSelected = effectiveSelected === runtime.runner
          const isStarting = isBuiltin && isBuiltinStarting && !runtime.available

          return (
            <div
              key={runtime.runner}
              className={`rounded-lg border text-left transition-colors ${
                isSelected ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/50'
              }`}
            >
              <button
                type="button"
                className="w-full flex items-start gap-3 p-3 text-left"
                onClick={() => setSelectedRunner(runtime.runner)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{runtime.info.name}</span>
                    {isBuiltin && (
                      <span className="text-xs text-muted-foreground">recommended</span>
                    )}
                    {runtime.available && (
                      <span className="text-xs bg-green-500/10 text-green-600 dark:text-green-400 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Check className="h-3 w-3" />
                        Running
                      </span>
                    )}
                    {isStarting && (
                      <span className="text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Starting...
                      </span>
                    )}
                    {!runtime.available && !isStarting && runtime.installed && !runtime.running && (
                      <span className="text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 px-2 py-0.5 rounded-full">
                        Installed (not running)
                      </span>
                    )}
                    {!runtime.installed && (
                      <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
                        Not installed
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{runtime.info.description}</p>
                </div>
                <div className={`mt-1 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                  isSelected ? 'border-primary' : 'border-muted-foreground/40'
                }`}>
                  {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
                </div>
              </button>

              {/* Expanded action area when selected */}
              <div className={`grid transition-all duration-200 ease-in-out ${isSelected ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <div className="px-3 pb-3">
                    {runtime.runner === 'wsl2' && showWsl2Guide ? (
                      <Wsl2InstallGuide
                        onRefresh={() => refreshAvailability.mutate()}
                        isRefreshing={refreshAvailability.isPending}
                      />
                    ) : runtime.available ? (
                      <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1.5">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                        </span>
                        Ready and running
                      </p>
                    ) : isStarting ? (
                      <p className="text-xs flex items-center gap-1.5">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-black/40 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-black" />
                        </span>
                        Starting up...
                      </p>
                    ) : runtime.installed && runtime.canStart ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs pl-[8px]"
                        onClick={() => handleStartRunner(runtime.runner)}
                        disabled={startRunner.isPending}
                      >
                        {startRunner.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Power className="!h-3 !w-3" />
                        )}
                        Start {runtime.info.name}
                      </Button>
                    ) : runtime.info.installUrl ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => handleOpenInstallLink(runtime.info.installUrl)}
                      >
                        Install {runtime.info.name}
                        <ArrowUpRight className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {!showMoreOptions ? (
        <div className="flex justify-start">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowMoreOptions(true)}
          >
            Show advanced options
          </button>
        </div>
      ) : (
        <div className="flex justify-between">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowMoreOptions(false)}
          >
            Show less
          </button>
          <button
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            onClick={() => refreshAvailability.mutate()}
            disabled={refreshAvailability.isPending}
          >
            <RefreshCw className={`h-3 w-3 ${refreshAvailability.isPending ? 'animate-spin' : ''}`} />
            Refresh runtime options
          </button>
        </div>
      )}

      <RequestError message={startRunner.error?.message ?? null} />

      {startRunner.isSuccess && startRunner.data?.message && (
        <p className="text-sm text-green-600 dark:text-green-400">
          {startRunner.data.message}
        </p>
      )}
    </div>
  )
}
