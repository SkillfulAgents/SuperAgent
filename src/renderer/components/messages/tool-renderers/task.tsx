
import { Bot } from 'lucide-react'
import { taskDef, type TaskInput } from '@shared/lib/tool-definitions/task'
import type { ToolRenderer, StreamingToolRendererProps } from './types'

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
  displayName: taskDef.displayName,
  icon: Bot,
  getSummary: taskDef.getSummary,
  StreamingView,
}
