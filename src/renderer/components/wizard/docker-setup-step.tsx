import { useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useStartRunner, useRefreshAvailability } from '@renderer/hooks/use-settings'
import {
  Loader2,
  Check,
  Play,
  ExternalLink,
  RefreshCw,
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
}

export function DockerSetupStep() {
  const { data: settings } = useSettings()
  const startRunner = useStartRunner()
  const refreshAvailability = useRefreshAvailability()

  const runtimeStatuses = useMemo(() => {
    if (!settings?.runnerAvailability) return []
    return settings.runnerAvailability.map((r) => ({
      ...r,
      info: RUNTIME_INFO[r.runner] || { name: r.runner, description: '', installUrl: '', icon: '📦' },
    }))
  }, [settings?.runnerAvailability])

  const hasAvailableRunner = useMemo(() => {
    return settings?.runnerAvailability?.some((r) => r.available) ?? false
  }, [settings?.runnerAvailability])

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

      {hasAvailableRunner && (
        <Alert>
          <Check className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700 dark:text-green-400">
            Container runtime is available. You&apos;re good to go!
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-3">
        {runtimeStatuses.map((runtime) => (
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
                {runtime.installed && !runtime.running && (
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
        ))}
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
