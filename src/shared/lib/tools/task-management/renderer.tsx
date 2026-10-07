import { defineToolRenderer } from '../renderer-types'
import { ListPlus, ListChecks, ListTodo } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { taskCreateDef, taskUpdateDef, taskListDef } from './definition'
import { TaskStatusIcon } from '../ui/shared'
import type { ToolRendererProps } from '../renderer-types'

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
      <TaskStatusIcon status={status} />
      <span className={cn(status === 'completed' && 'text-muted-foreground')}>
        Task #{taskId}
      </span>
    </div>
  )
}

export const taskCreateRenderer = defineToolRenderer(taskCreateDef, {
  icon: ListPlus,
  ExpandedView: TaskCreateExpandedView,
})

export const taskUpdateRenderer = defineToolRenderer(taskUpdateDef, {
  icon: ListChecks,
  ExpandedView: TaskUpdateExpandedView,
})

export const taskListRenderer = defineToolRenderer(taskListDef, {
  icon: ListTodo,
})
