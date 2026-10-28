import { defineToolRenderer } from '../renderer-types'
import { Workflow } from 'lucide-react'
import { taskDef, type TaskInput } from './definition'
import type { StreamingToolRendererProps } from '../renderer-types'

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: TaskInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Workflow className="h-3 w-3 text-foreground" />
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

export const taskRenderer = defineToolRenderer(taskDef, {
  icon: Workflow,
  StreamingView,
})
