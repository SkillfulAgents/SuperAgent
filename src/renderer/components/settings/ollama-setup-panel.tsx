import { useState } from 'react'
import { AlertTriangle, ChevronDown, Download, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { Input } from '@renderer/components/ui/input'
import { useServerStatus, type ModelServerTarget } from '@renderer/hooks/use-model-server'
import { canUseHostFeatures } from '@renderer/lib/capabilities'
import { serverFacts } from '@renderer/lib/facts'
import type { ServerFacts } from '@shared/lib/facts/facts-schema'
import { isLoopbackUrl } from '@shared/lib/llm-provider/container-url'
import { MIN_AGENT_CONTEXT_TOKENS, MIN_OLLAMA_VERSION, normalizeOllamaBaseUrl } from '@shared/lib/llm-provider/ollama-schema'
import type { ServerStatus } from '@shared/lib/llm-provider/server-status-schema'
import { CopyableValue, SetupPanel, SetupSteps } from './setup-steps'

const DOWNLOAD_PAGE = 'https://ollama.com/download'

interface InstallOption {
  link: { href: string; label: string }
  command?: { label: string; value: string }
}

/** Ollama's own install instructions for each OS, from ollama.com/download. */
export function installOptionFor(os: ServerFacts['os'] | undefined): InstallOption {
  switch (os) {
    case 'darwin':
      return { link: { href: `${DOWNLOAD_PAGE}/mac`, label: 'Download Ollama for Mac' } }
    case 'win32':
      return {
        link: { href: `${DOWNLOAD_PAGE}/windows`, label: 'Download Ollama for Windows' },
        command: { label: 'Or run this in PowerShell:', value: 'irm https://ollama.com/install.ps1 | iex' },
      }
    case 'linux':
      return {
        link: { href: `${DOWNLOAD_PAGE}/linux`, label: 'Ollama for Linux' },
        command: { label: 'Run this in a terminal:', value: 'curl -fsSL https://ollama.com/install.sh | sh' },
      }
    default:
      return { link: { href: DOWNLOAD_PAGE, label: 'Download Ollama' } }
  }
}

export function ExternalAnchor({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 text-primary underline underline-offset-4">
      {children}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  )
}

function InstallInstructions({ status }: { status: Exclude<ServerStatus, { state: 'running' }> }) {
  const facts = serverFacts()
  const option = installOptionFor(facts?.os)
  // The server looks for Ollama on its own machine, which is this computer only in the desktop app.
  const where = canUseHostFeatures() ? 'on this computer' : 'on the machine running this workspace'
  if (status.state === 'stopped') {
    return (
      <SetupPanel
        data-testid="ollama-stopped"
        notes={[status.error, 'This page updates on its own once Ollama answers.']}
      >
        <p className="font-medium">Ollama is installed but not running</p>
        <div className="flex flex-col text-muted-foreground">
          {facts?.os === 'linux' ? 'Start it from a terminal:' : 'Open the Ollama app, or start it from a terminal:'}
          <CopyableValue value="ollama serve" label="Copy command" />
        </div>
      </SetupPanel>
    )
  }
  return (
    <SetupPanel
      data-testid="ollama-install"
      notes={[
        'Ollama is free and runs models on your own hardware.',
        'This page updates on its own once Ollama answers. If it uses another port or machine, set up the connection below.',
      ]}
    >
      <p className="font-medium">Ollama wasn&apos;t found {where}</p>
      <SetupSteps
        steps={[
          <>
            <ExternalAnchor href={option.link.href}>{option.link.label}</ExternalAnchor>
            {option.command && (
              <>
                <span className="mt-2 text-muted-foreground">{option.command.label}</span>
                <CopyableValue value={option.command.value} label="Copy command" />
              </>
            )}
          </>,
          'Open Ollama once it has installed. You can pick a model to download here afterwards.',
        ]}
      />
    </SetupPanel>
  )
}

function RunningStatus({ status, onManageModels, canDownload }: {
  status: Extract<ServerStatus, { state: 'running' }>
  onManageModels: () => void
  canDownload: boolean
}) {
  const usable = status.models.filter(model => !model.unusableReason)
  // A container reaches a loopback server through the Linux bridge, which Ollama's default bind refuses.
  const needsWiderBind = serverFacts()?.os === 'linux' && isLoopbackUrl(status.baseUrl)
  return (
    <div className="rounded-card border p-4 text-sm space-y-3" data-testid="ollama-running">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
            Ollama is running{status.version ? ` · v${status.version}` : ''}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {status.baseUrl} · {usable.length === 0 ? 'No models yet' : `${usable.length} ${usable.length === 1 ? 'model' : 'models'} ready for agents`}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onManageModels} data-testid="ollama-manage-models">
          {canDownload && <Download className="h-3.5 w-3.5" />}
          {canDownload ? 'Download models' : 'View models'}
        </Button>
      </div>
      {status.upgradeRequired && (
        <Warning>This version is too old to run agents. Update to Ollama {MIN_OLLAMA_VERSION} or newer.</Warning>
      )}
      {status.smallContext && (
        <Warning>
          {status.smallContext.model} loaded with a {status.smallContext.tokens.toLocaleString()}-token context, and Ollama silently cuts off whatever does not fit.
          Agents need at least {MIN_AGENT_CONTEXT_TOKENS.toLocaleString()}: start Ollama with <code className="font-mono">OLLAMA_CONTEXT_LENGTH=64000</code>.
        </Warning>
      )}
      {needsWiderBind && (
        <p className="text-[11px] text-muted-foreground">
          Agent containers reach this machine over Docker&apos;s bridge. If their requests fail, start Ollama with <code className="font-mono">OLLAMA_HOST=0.0.0.0</code>.
        </p>
      )}
    </div>
  )
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

/**
 * The top of the Ollama connection editor: what the server at the chosen URL is
 * doing, and how to get from there to running. It asks about `target`, the
 * connection as edited, since one being set up has not been saved yet.
 */
export function OllamaSetupPanel({ target, baseUrl, onBaseUrlChange, onManageModels, canDownload }: {
  target: ModelServerTarget
  /** The URL last committed, already normalized. */
  baseUrl: string
  onBaseUrlChange: (baseUrl: string) => void
  onManageModels: () => void
  canDownload: boolean
}) {
  const status = useServerStatus(target)
  const [draft, setDraft] = useState(baseUrl)
  const [urlError, setUrlError] = useState<string>()
  const data = status.data
  const commit = () => {
    try {
      const next = normalizeOllamaBaseUrl(draft)
      setUrlError(undefined)
      setDraft(next)
      if (next === baseUrl) void status.refetch()
      else onBaseUrlChange(next)
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : 'Enter a valid URL')
    }
  }
  const unreachable = data?.state === 'unreachable'
  return (
    <div className="grid gap-3" data-testid="ollama-setup">
      {!data && !status.isError && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Looking for Ollama…
        </p>
      )}
      {status.isError && <p role="alert" className="text-sm text-destructive">{status.error.message}</p>}
      {data?.state === 'running' && <RunningStatus status={data} onManageModels={onManageModels} canDownload={canDownload} />}
      {(data?.state === 'stopped' || data?.state === 'not-found') && <InstallInstructions status={data} />}
      {unreachable && (
        <SetupPanel data-testid="ollama-unreachable" notes={['Check that Ollama is running there and listening on an address this machine can reach (OLLAMA_HOST).']}>
          <p className="font-medium">Can&apos;t reach Ollama</p>
          <p className="text-muted-foreground">{data.error}</p>
        </SetupPanel>
      )}
      {/* Open from the start when the URL is why nothing answers, so the fix is in view. */}
      <Collapsible key={unreachable ? 'unreachable' : 'other'} defaultOpen={unreachable} className="grid gap-2 text-sm" data-testid="ollama-connection-settings">
        <CollapsibleTrigger
          data-testid="ollama-connection-settings-trigger"
          className="flex w-fit items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
        >
          Set up connection
          <ChevronDown className="h-4 w-4 shrink-0 opacity-70 transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
        </CollapsibleTrigger>
        {/* No display class on the content itself: it would override the `hidden` that closes it. */}
        <CollapsibleContent className="rounded-card border">
          <div className="grid gap-2 p-4">
            <label htmlFor="ollama-base-url" className="text-xs font-medium">Ollama address</label>
            <div className="flex gap-2">
              <Input
                id="ollama-base-url"
                className="flex-1"
                value={draft}
                aria-invalid={urlError ? true : undefined}
                aria-describedby={urlError ? 'ollama-base-url-error' : 'ollama-base-url-hint'}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  // Enter here tests the address; it must not submit the connection form.
                  if (event.key === 'Enter') { event.preventDefault(); commit() }
                }}
              />
              <Button type="button" variant="outline" onClick={commit} disabled={status.isFetching}>Test connection</Button>
            </div>
            {urlError
              ? <p id="ollama-base-url-error" role="alert" className="text-xs text-destructive">{urlError}</p>
              : <p id="ollama-base-url-hint" className="text-[11px] text-muted-foreground">Change this if Ollama uses another port or runs on another machine.</p>}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
