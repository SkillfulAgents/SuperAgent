import { AlertTriangle, Copy, ExternalLink, Shield } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import type { RunnerSetupRemediation } from '@shared/lib/container/wsl2-setup-errors'
import { RunnerSetupFailedError } from '@renderer/hooks/use-settings'

interface RunnerSetupErrorPanelProps {
  error: unknown
  className?: string
}

/**
 * Extract a typed runner setup payload from a hook error, if present.
 * Returns null for generic errors so callers can fall back to a plain message.
 */
export function getRunnerSetupPayload(error: unknown): RunnerSetupRemediation | null {
  if (error instanceof RunnerSetupFailedError) return error.setupError
  return null
}

export function RunnerSetupErrorPanel({ error, className }: RunnerSetupErrorPanelProps) {
  const payload = getRunnerSetupPayload(error)
  if (!payload) return null

  const copyCommands = () => {
    const text = payload.steps
      .filter(s => s.command)
      .map(s => s.command)
      .join('\n')
    if (!text) return
    // navigator.clipboard is undefined on insecure contexts / some Electron
    // configs; writeText() also rejects when the document isn't focused.
    // Swallow both — copy failure is non-fatal and the commands are visible
    // on-screen.
    try {
      const result = navigator.clipboard?.writeText?.(text)
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.warn('Clipboard write failed', err))
      }
    } catch (err) {
      console.warn('Clipboard unavailable', err)
    }
  }

  const openDocs = () => {
    if (payload.docsUrl) {
      window.open(payload.docsUrl, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div className={`rounded-lg border border-destructive/30 bg-destructive/5 p-4 ${className ?? ''}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <p className="text-sm font-semibold text-destructive">{payload.title}</p>
            <p className="text-sm text-muted-foreground mt-1">{payload.remediation}</p>
          </div>

          {payload.steps.length > 0 && (
            <ol className="space-y-2 text-sm list-decimal list-inside marker:text-muted-foreground">
              {payload.steps.map((step, i) => (
                <li key={i} className="text-foreground">
                  <span>{step.label}</span>
                  {step.command && (
                    <div className="mt-1 ml-4 flex items-center gap-2">
                      <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono break-all">
                        {step.command}
                      </code>
                      {step.elevated && (
                        <span
                          title="Requires administrator (run in elevated PowerShell)"
                          className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                        >
                          <Shield className="h-3 w-3" />
                          Admin
                        </span>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {payload.steps.some(s => s.command) && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={copyCommands}>
                <Copy className="h-3 w-3 mr-1" />
                Copy commands
              </Button>
            )}
            {payload.docsUrl && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openDocs}>
                <ExternalLink className="h-3 w-3 mr-1" />
                View docs
              </Button>
            )}
          </div>

          {payload.originalStderr && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Technical details</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px]">
                {payload.originalStderr}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
