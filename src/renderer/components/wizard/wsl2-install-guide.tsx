import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import {
  Terminal,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react'

interface Wsl2InstallGuideProps {
  onRefresh: () => void
  isRefreshing: boolean
}

const WSL_INSTALL_COMMAND = 'wsl --install'

export function Wsl2InstallGuide({ onRefresh, isRefreshing }: Wsl2InstallGuideProps) {
  const [copied, setCopied] = useState(false)
  const [launched, setLaunched] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)

  const handleLaunchInstall = async () => {
    setLaunchError(null)
    try {
      await window.electronAPI?.launchPowershellAdmin(WSL_INSTALL_COMMAND)
      setLaunched(true)
    } catch (error: any) {
      console.error('Failed to launch PowerShell:', error)
      setLaunchError(error?.message || 'Failed to launch PowerShell. Try running the command manually.')
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
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Set Up Windows Subsystem for Linux (WSL2)</h3>
        <p className="text-xs text-muted-foreground mt-1">
          The built-in runtime requires WSL2, which is a one-time setup on Windows.
        </p>
      </div>

      <div className="space-y-3 text-sm">
        <div className="flex gap-3">
          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-medium">1</span>
          <div className="flex-1">
            <p>Click below to open an Administrator PowerShell that will install WSL2.</p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={handleLaunchInstall}
              >
                <Terminal className="h-3 w-3 mr-1" />
                {launched ? 'Open PowerShell Again' : 'Open PowerShell (Admin)'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              You may see a Windows security prompt (UAC) — click Yes to allow.
            </p>
            {launchError && (
              <p className="text-xs text-destructive mt-1.5">{launchError}</p>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-medium">2</span>
          <div className="flex-1">
            <p>After the installation completes, <strong>restart your computer</strong>.</p>
          </div>
        </div>

        <div className="flex gap-3">
          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-medium">3</span>
          <div className="flex-1">
            <p>Reopen Superagent — setup will resume from here.</p>
          </div>
        </div>
      </div>

      {/* Manual command fallback */}
      <div className="rounded-md bg-muted px-3 py-2 flex items-center justify-between gap-2">
        <code className="text-xs font-mono">{WSL_INSTALL_COMMAND}</code>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 shrink-0"
          onClick={handleCopyCommand}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>

      {launched && (
        <Alert>
          <AlertDescription className="text-xs">
            After the install finishes in PowerShell and you restart your computer, click Recheck below.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} />
          Recheck WSL2 Status
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          onClick={handleOpenDocs}
        >
          <ExternalLink className="h-3 w-3 mr-1" />
          Microsoft Docs
        </Button>
      </div>
    </div>
  )
}
