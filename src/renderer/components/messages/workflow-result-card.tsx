import { CheckCircle2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import type { WorkflowResultNotification } from '@shared/lib/utils/task-notifications'

/**
 * Renders the result of a completed dynamic workflow, parsed out of an inline
 * `<task-notification type="workflow-complete">` block (see parseTaskNotifications).
 * Used in place of the raw XML the SDK appends to assistant text on the busy path.
 */
export function WorkflowResultCard({ notification }: { notification: WorkflowResultNotification }) {
  return (
    <div className="text-sm border border-border/70 rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-muted/40">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        <span className="font-sans text-sm text-foreground/70 leading-none">Workflow completed</span>
        {notification.title && (
          <span className="text-muted-foreground/70 truncate text-xs leading-none">{notification.title}</span>
        )}
      </div>
      <div className="px-3 py-2 prose prose-sm max-w-none min-w-0 break-words dark:prose-invert prose-strong:font-medium">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform}>
          {notification.result}
        </ReactMarkdown>
      </div>
    </div>
  )
}
