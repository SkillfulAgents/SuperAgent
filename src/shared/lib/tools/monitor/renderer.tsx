import { Radar } from 'lucide-react'
import { defineToolRenderer } from '../renderer-types'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import { monitorDef, type MonitorInput } from './definition'
import type { ToolRendererProps, StreamingToolRendererProps } from '../renderer-types'

// The runtime's default and cap for timeout_ms (the tool's own schema text).
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000

function formatTimeout(timeoutMs: unknown): string {
  const ms = Math.min(typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : formatElapsed(ms)
}

function Source({ input, streaming = false }: { input: MonitorInput; streaming?: boolean }) {
  if (input.ws && typeof input.ws.url === 'string') {
    return (
      <div className="rounded-md border border-border/70 bg-background px-3 py-2 font-mono text-xs" data-testid="monitor-source-ws">
        <span className="select-none text-muted-foreground">WebSocket </span>
        <span className="break-all">{input.ws.url}</span>
        {Array.isArray(input.ws.protocols) && input.ws.protocols.length > 0 && (
          <span className="text-muted-foreground"> ({input.ws.protocols.join(', ')})</span>
        )}
      </div>
    )
  }
  return (
    <div className="rounded-md bg-black overflow-hidden" data-testid="monitor-source-command">
      <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs font-bold text-white">
        <span className="select-none text-gray-500">$ </span>
        {typeof input.command === 'string' && input.command
          ? input.command
          : <span className="italic text-gray-600">...</span>}
        {streaming && <span className="animate-pulse text-gray-400">|</span>}
      </pre>
    </div>
  )
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const parsed = monitorDef.parseInput(input)
  return (
    <div className="space-y-2">
      <Source input={parsed} />
      <div className="text-xs text-muted-foreground">
        {parsed.ws ? 'Each message it receives' : 'Each line it prints'} wakes the agent. Stops after {formatTimeout(parsed.timeout_ms)} unless it ends first.
      </div>
      {/* The started text is addressed to the agent; only a refusal is news here. */}
      {isError && result && (
        <pre className="m-0 whitespace-pre-wrap break-words rounded-md bg-background p-2 text-xs text-red-800 dark:text-red-200">
          {result}
        </pre>
      )}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: MonitorInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }
  return (
    <div className="space-y-1">
      {parsed.description && <div className="text-xs text-muted-foreground">{parsed.description}</div>}
      <Source input={parsed} streaming />
    </div>
  )
}

export const monitorRenderer = defineToolRenderer(monitorDef, {
  icon: Radar,
  ExpandedView,
  StreamingView,
})
