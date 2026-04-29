
import { LayoutDashboard, Play, List, ScrollText } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps } from './types'
import {
  createDashboardDef, startDashboardDef, listDashboardsDef, getDashboardLogsDef,
  type CreateDashboardInput, type DashboardSlugInput,
} from '@shared/lib/tool-definitions/dashboard-tools'

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

export const createDashboardRenderer: ToolRenderer = {
  displayName: createDashboardDef.displayName,
  icon: LayoutDashboard,
  getSummary: createDashboardDef.getSummary,
  ExpandedView: CreateDashboardExpandedView,
}

// ── start_dashboard ───────────────────────────────────────────

export const startDashboardRenderer: ToolRenderer = {
  displayName: startDashboardDef.displayName,
  icon: Play,
  getSummary: startDashboardDef.getSummary,
}

// ── list_dashboards ───────────────────────────────────────────

export const listDashboardsRenderer: ToolRenderer = {
  displayName: listDashboardsDef.displayName,
  icon: List,
}

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
          <div className="text-xs font-medium text-muted-foreground mb-1">
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

export const getDashboardLogsRenderer: ToolRenderer = {
  displayName: getDashboardLogsDef.displayName,
  icon: ScrollText,
  getSummary: getDashboardLogsDef.getSummary,
  ExpandedView: DashboardLogsExpandedView,
}
