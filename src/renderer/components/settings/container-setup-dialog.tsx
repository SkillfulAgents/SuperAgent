
import { useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useSettings, useStartRunner } from '@renderer/hooks/use-settings'
import { Play, Loader2, ExternalLink, Check } from 'lucide-react'

interface ContainerSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const RUNTIME_INFO = {
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

export function ContainerSetupDialog({ open, onOpenChange }: ContainerSetupDialogProps) {
  const { data: settings } = useSettings()
  const startRunner = useStartRunner()

  const runtimeStatuses = useMemo(() => {
    if (!settings?.runnerAvailability) return []
    return settings.runnerAvailability.map((r) => ({
      ...r,
      info: RUNTIME_INFO[r.runner as keyof typeof RUNTIME_INFO],
    }))
  }, [settings?.runnerAvailability])

  const handleStartRunner = async (runner: 'docker' | 'podman') => {
    try {
      await startRunner.mutateAsync(runner)
    } catch (error) {
      console.error('Failed to start runner:', error)
    }
  }

  const handleOpenInstallLink = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Container Runtime Required</DialogTitle>
          <DialogDescription>
            Superagent runs AI agents in isolated containers for security and consistency.
            You need a container runtime installed and running to use Superagent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="text-sm text-muted-foreground">
            <p className="mb-2">
              <strong>What are containers?</strong>
            </p>
            <p>
              Containers are lightweight, isolated environments that package an application
              with all its dependencies. This ensures your AI agents run consistently and
              securely, without affecting your system.
            </p>
          </div>

          <div className="border-t pt-4">
            <p className="text-sm font-medium mb-3">Supported Runtimes</p>
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
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => onOpenChange(false)}
                        >
                          <Check className="h-3 w-3 mr-1" />
                          Ready to use
                        </Button>
                      ) : runtime.installed && runtime.canStart ? (
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleStartRunner(runtime.runner as 'docker' | 'podman')}
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
          </div>

          {startRunner.error && (
            <p className="text-sm text-destructive">
              {startRunner.error.message}
            </p>
          )}

          {startRunner.isSuccess && startRunner.data?.message && (
            <p className="text-sm text-green-600 dark:text-green-400">
              {startRunner.data.message}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
