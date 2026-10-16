import { defineToolRenderer } from '../renderer-types'
import { SquareMousePointer, SquareGanttChart, Code } from 'lucide-react'
import type { ToolRendererProps } from '../renderer-types'
import {
  createDashboardDef, startDashboardDef, listDashboardsDef, getDashboardLogsDef,
  type CreateDashboardInput, type DashboardSlugInput,
} from './definition'

// ── create_dashboard ──────────────────────────────────────────

function CreateDashboardExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug, name, description, framework } = input as CreateDashboardInput

  return (
    <div className="space-y-2">
      {/* Dashboard info */}
      <div className="flex items-center gap-2 flex-wrap">
        {name && (
          <span className="font-medium text-xs">{name}</span>
        )}
        {slug && (
          <code className="bg-background px-1.5 py-0.5 rounded text-xs">{slug}</code>
        )}
        {framework && (
          <span className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 px-1.5 py-0.5 rounded text-xs font-medium">
            {framework}
          </span>
        )}
      </div>

      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}

      {result && (
        <div
          className={`bg-background rounded p-2 text-xs ${
            isError
              ? 'text-red-800 dark:text-red-200'
              : 'text-green-800 dark:text-green-200'
          }`}
        >
          {result}
        </div>
      )}
    </div>
  )
}

export const createDashboardRenderer = defineToolRenderer(createDashboardDef, {
  icon: Code,
  ExpandedView: CreateDashboardExpandedView,
})

// ── start_dashboard ───────────────────────────────────────────

export const startDashboardRenderer = defineToolRenderer(startDashboardDef, {
  icon: SquareMousePointer,
})

// ── list_dashboards ───────────────────────────────────────────

export const listDashboardsRenderer = defineToolRenderer(listDashboardsDef, {
  icon: SquareGanttChart,
})

// ── get_dashboard_logs ────────────────────────────────────────

function DashboardLogsExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug, clear } = input as DashboardSlugInput

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        {slug && (
          <code className="bg-background px-1.5 py-0.5 rounded text-xs">{slug}</code>
        )}
        {clear && (
          <span className="text-xs text-muted-foreground">(cleared after read)</span>
        )}
      </div>

      {result && (
        <div>
          <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">
            {isError ? 'Error' : 'Logs'}
          </div>
          <pre
            className={`bg-background rounded p-2 text-xs overflow-x-auto max-h-60 overflow-y-auto font-mono ${
              isError ? 'text-red-800 dark:text-red-200' : ''
            }`}
          >
            {result}
          </pre>
        </div>
      )}
    </div>
  )
}

export const getDashboardLogsRenderer = defineToolRenderer(getDashboardLogsDef, {
  icon: Code,
  ExpandedView: DashboardLogsExpandedView,
})
