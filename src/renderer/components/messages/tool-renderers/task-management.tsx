import { ListPlus, ListChecks, ListTodo } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { taskCreateDef, taskUpdateDef, taskListDef } from '@shared/lib/tool-definitions/task-management'
import type { ToolRenderer, ToolRendererProps } from './types'

function TaskCreateExpandedView({ input }: ToolRendererProps) {
  const { subject, description } = taskCreateDef.parseInput(input)
  return (
    <div className="space-y-1 text-xs">
      {subject && <div className="font-medium">{subject}</div>}
      {description && <div className="text-muted-foreground">{description}</div>}
    </div>
  )
}

function TaskUpdateExpandedView({ input }: ToolRendererProps) {
  const { taskId, status } = taskUpdateDef.parseInput(input)
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-xs">
        {status === 'completed' && <span className="text-green-500">✓</span>}
        {status === 'in_progress' && <span className="text-blue-500">→</span>}
        {status === 'pending' && <span className="text-muted-foreground">○</span>}
      </span>
      <span className={cn(status === 'completed' && 'text-muted-foreground')}>
        Task #{taskId}
      </span>
    </div>
  )
}

export const taskCreateRenderer: ToolRenderer = {
  displayName: taskCreateDef.displayName,
  icon: ListPlus,
  getSummary: taskCreateDef.getSummary,
  ExpandedView: TaskCreateExpandedView,
}

export const taskUpdateRenderer: ToolRenderer = {
  displayName: taskUpdateDef.displayName,
  icon: ListChecks,
  getSummary: taskUpdateDef.getSummary,
  ExpandedView: TaskUpdateExpandedView,
}

export const taskListRenderer: ToolRenderer = {
  displayName: taskListDef.displayName,
  icon: ListTodo,
}
