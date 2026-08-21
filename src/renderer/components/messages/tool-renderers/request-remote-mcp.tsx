
import { Blocks } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { Field, ResultField } from './shared'
import { requestRemoteMcpDef, type RequestRemoteMcpInput } from '@shared/lib/tool-definitions/request-remote-mcp'

const parseInput = requestRemoteMcpDef.parseInput

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { url, name, reason } = parseInput(input)

  return (
    <div className="space-y-2">
      {name && <Field label="Server" className="font-medium">{name}</Field>}
      {url && <Field label="URL" className="font-mono truncate">{url}</Field>}
      {reason && <Field label="Reason">{reason}</Field>}
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: RequestRemoteMcpInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <Field label="Server" className="font-medium">
        {parsed.name || parsed.url || <span className="text-muted-foreground italic">...</span>}
      </Field>
      {parsed.url && parsed.name && (
        <Field label="URL" className="font-mono truncate">
          {parsed.url}
          <span className="animate-pulse">|</span>
        </Field>
      )}
      {parsed.reason && (
        <Field label="Reason">
          {parsed.reason}
          <span className="animate-pulse">|</span>
        </Field>
      )}
    </div>
  )
}

export const requestRemoteMcpRenderer: ToolRenderer = {
  displayName: 'Request MCP Server',
  icon: Blocks,
  getSummary: requestRemoteMcpDef.getSummary,
  ExpandedView,
  StreamingView,
}
