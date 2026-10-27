import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { RequestError } from '@shared/lib/tools/requests/request-error'
import { RefreshCw, MoveRight } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { canUseHostFeatures } from '@renderer/lib/capabilities'

interface Wsl2InstallGuideProps {
  onRefresh: () => void
  isRefreshing: boolean
}

const WSL_INSTALL_COMMAND = 'wsl --install'

/** Shown when the computer that runs the API is Windows without WSL2, which may not be this one. */
export function Wsl2InstallGuide({ onRefresh, isRefreshing }: Wsl2InstallGuideProps) {
  // The PowerShell button opens PowerShell on this computer, so it is offered
  // only when this is the computer that needs WSL2. A browser, or a desktop app
  // driving another machine, gets the steps to run there by hand.
  const onThisComputer = canUseHostFeatures()
  const [copied, setCopied] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)

  const handleLaunchInstall = async () => {
    setLaunchError(null)
    try {
      await window.electronAPI?.launchPowershellAdmin(WSL_INSTALL_COMMAND)
    } catch (error: unknown) {
      console.error('Failed to launch PowerShell:', error)
      setLaunchError(error instanceof Error ? error.message : 'Failed to launch PowerShell. Try running the command manually.')
    }
  }

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(WSL_INSTALL_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard not available
    }
  }

  const handleOpenDocs = () => {
    if (window.electronAPI) {
      window.electronAPI.openExternal('https://learn.microsoft.com/en-us/windows/wsl/install')
    } else {
      window.open('https://learn.microsoft.com/en-us/windows/wsl/install', '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div className="space-y-3">
      <hr className="border-border" />
      <p className="text-sm text-foreground/70">
        {onThisComputer
          ? 'WSL2 required. Follow these steps to set up.'
          : 'WSL2 required on the computer that runs Gamut. Follow these steps on that computer.'}
      </p>

      <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
        {onThisComputer ? (
          <>
            <li>
              Click this <MoveRight className="h-3 w-3 inline -mt-0.5" />{' '}
              <TooltipProvider delayDuration={0}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs"
                      onClick={handleLaunchInstall}
                    >
                      Open PowerShell
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Opens PowerShell in admin mode</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </li>
            <li>If prompted by Windows Security, click Yes to allow.</li>
          </>
        ) : (
          <li>Open PowerShell as administrator.</li>
        )}
        <li>
          Paste this <MoveRight className="h-3 w-3 inline -mt-0.5" />{' '}
          <TooltipProvider delayDuration={0}>
            <Tooltip open={copied || undefined}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-input bg-background px-3 py-0.5 text-xs font-mono cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors"
                  onClick={handleCopyCommand}
                >
                  {WSL_INSTALL_COMMAND}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{copied ? 'Copied!' : 'Click to copy'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {' '}into PowerShell. Then press Enter.
        </li>
        <li>
          {onThisComputer
            ? 'Restart your computer, then reopen Gamut.'
            : 'Restart that computer, then start Gamut on it again.'}
        </li>
      </ol>

      <RequestError message={launchError ?? null} />

      <div className="flex items-center justify-between text-xs text-muted-foreground pt-3">
        <p>
          Having issues?{' '}
          <button
            className="underline underline-offset-2 hover:text-foreground transition-colors"
            onClick={handleOpenDocs}
          >
            View Microsoft Docs
          </button>
        </p>
        <button
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors disabled:opacity-50"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={`h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} />
          Recheck WSL2 status
        </button>
      </div>
    </div>
  )
}
