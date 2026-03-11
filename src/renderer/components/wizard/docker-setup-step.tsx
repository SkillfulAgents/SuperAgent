import { useState, useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { useSettings, useStartRunner, useRefreshAvailability } from '@renderer/hooks/use-settings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import {
  Loader2,
  Check,
  Play,
  ExternalLink,
  RefreshCw,
  ChevronDown,
} from 'lucide-react'

const RUNTIME_INFO: Record<string, { name: string; description: string; installUrl: string; icon: string }> = {
  'apple-container': {
    name: 'macOS Container',
    description: 'Native container runtime built into macOS. Fast and lightweight with no extra software needed.',
    installUrl: 'https://github.com/apple/container',
    icon: '🍎',
  },
  docker: {
    name: 'Docker Desktop',
    description: 'The most popular container runtime. Easy to use with a graphical interface.',
    installUrl: 'https://www.docker.com/products/docker-desktop/',
    icon: '🐳',
  },
  podman: {
    name: 'Podman',
    description: 'A lightweight, daemonless container engine. Great alternative to Docker.',
    installUrl: 'https://podman.io/getting-started/installation',
    icon: '🦭',
  },
  lima: {
    name: 'Built-in Runtime',
    description: 'Bundled lightweight container runtime. No extra software needed — just works.',
    installUrl: '',
    icon: '📦',
  },
}

export function DockerSetupStep() {
  const { data: settings } = useSettings()
  const { data: runtimeStatus } = useRuntimeStatus()
  const startRunner = useStartRunner()
  const refreshAvailability = useRefreshAvailability()
  const [othersOpen, setOthersOpen] = useState(false)

  // Detect if the built-in runtime is actively starting
  const isLimaStarting = runtimeStatus?.runtimeReadiness?.status === 'CHECKING' &&
    runtimeStatus.runtimeReadiness.message?.toLowerCase().includes('built-in')

  const runtimeStatuses = useMemo(() => {
    if (!settings?.runnerAvailability) return []
    return settings.runnerAvailability.map((r) => ({
      ...r,
      info: RUNTIME_INFO[r.runner] || { name: r.runner, description: '', installUrl: '', icon: '📦' },
      // Lima counts as "effectively available" while it's starting
      effectivelyAvailable: r.available || (r.runner === 'lima' && isLimaStarting),
    }))
  }, [settings?.runnerAvailability, isLimaStarting])

  // Split into primary (available/starting) and others
  const primaryRuntime = runtimeStatuses.find((r) => r.effectivelyAvailable)
  const otherRuntimes = runtimeStatuses.filter((r) => r !== primaryRuntime)

  const hasAvailableRunner = primaryRuntime != null

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

  const renderRuntime = (runtime: typeof runtimeStatuses[number]) => {
    const isStarting = runtime.runner === 'lima' && isLimaStarting && !runtime.available

    return (
      <div
        key={runtime.runner}
        className="flex items-start gap-3 p-3 rounded-lg border bg-card"
      >
        <span className="text-2xl">{runtime.info.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{runtime.info.name}</span>
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
          <p className="text-xs text-muted-foreground mt-1">
            {runtime.info.description}
          </p>
          <div className="mt-2">
            {runtime.available ? (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled>
                <Check className="h-3 w-3 mr-1" />
                Ready to use
              </Button>
            ) : isStarting ? (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                Starting...
              </Button>
            ) : runtime.installed && runtime.canStart ? (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => handleStartRunner(runtime.runner)}
                disabled={startRunner.isPending}
              >
                {startRunner.isPending ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                Start {runtime.info.name}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => handleOpenInstallLink(runtime.info.installUrl)}
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Install {runtime.info.name}
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold">Set Up Container Runtime</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Superagent runs AI agents in isolated containers. You need a container runtime installed and running.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs shrink-0"
          onClick={() => refreshAvailability.mutate()}
          disabled={refreshAvailability.isPending}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${refreshAvailability.isPending ? 'animate-spin' : ''}`} />
          Recheck
        </Button>
      </div>

      {hasAvailableRunner && !isLimaStarting && (
        <Alert>
          <Check className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700 dark:text-green-400">
            Container runtime is available. You&apos;re good to go!
          </AlertDescription>
        </Alert>
      )}

      {isLimaStarting && (
        <Alert>
          <Loader2 className="h-4 w-4 animate-spin" />
          <AlertDescription>
            {runtimeStatus?.runtimeReadiness?.message || 'Starting container runtime...'}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-3">
        {/* Primary runtime (available or starting) shown at top */}
        {primaryRuntime && renderRuntime(primaryRuntime)}

        {/* Other runtimes collapsed if there's a primary */}
        {primaryRuntime && otherRuntimes.length > 0 ? (
          <Collapsible open={othersOpen} onOpenChange={setOthersOpen}>
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-1">
                <ChevronDown className={`h-3 w-3 transition-transform ${othersOpen ? 'rotate-180' : ''}`} />
                Other runtimes
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-1">
              {otherRuntimes.map(renderRuntime)}
            </CollapsibleContent>
          </Collapsible>
        ) : (
          /* No primary — show all runtimes flat */
          otherRuntimes.map(renderRuntime)
        )}
      </div>

      {startRunner.error && (
        <p className="text-sm text-destructive">{startRunner.error.message}</p>
      )}

      {startRunner.isSuccess && startRunner.data?.message && (
        <p className="text-sm text-green-600 dark:text-green-400">
          {startRunner.data.message}
        </p>
      )}
    </div>
  )
}
