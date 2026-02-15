
import { Bot } from 'lucide-react'
import type { ToolRenderer, StreamingToolRendererProps } from './types'

interface TaskInput {
  subagent_type?: string
  description?: string
  prompt?: string
}

function parseTaskInput(input: unknown): TaskInput {
  if (typeof input === 'object' && input !== null) {
    return input as TaskInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { subagent_type, description } = parseTaskInput(input)
  const parts: string[] = []
  if (subagent_type) parts.push(`[${subagent_type}]`)
  if (description) parts.push(description)
  return parts.length > 0 ? parts.join(' ') : null
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: TaskInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Bot className="h-4 w-4 text-blue-500" />
        <span className="text-muted-foreground italic">Launching sub-agent...</span>
      </div>
      {parsed.subagent_type && (
        <div className="text-xs text-muted-foreground">
          Type: <span className="font-medium text-foreground">{parsed.subagent_type}</span>
        </div>
      )}
      {parsed.description && (
        <div className="text-xs text-muted-foreground">
          {parsed.description}
        </div>
      )}
    </div>
  )
}

export const taskRenderer: ToolRenderer = {
  displayName: 'Sub Agent',
  icon: Bot,
  getSummary,
  StreamingView,
}
