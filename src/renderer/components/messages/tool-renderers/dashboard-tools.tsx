
import { LayoutDashboard, Play, List, ScrollText } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps } from './types'

// ── Types ─────────────────────────────────────────────────────

interface CreateDashboardInput {
  slug?: string
  name?: string
  description?: string
  framework?: 'plain' | 'react'
}

interface DashboardSlugInput {
  slug?: string
  clear?: boolean
}

// ── create_dashboard ──────────────────────────────────────────

function CreateDashboardExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug, name, description, framework } = input as CreateDashboardInput

  return (
    <div className="space-y-2">
      {/* Dashboard info */}
      <div className="flex items-center gap-2 flex-wrap">
        {name && (
          <span className="font-medium text-sm">{name}</span>
        )}
        {slug && (
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{slug}</code>
        )}
        {framework && (
          <span className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 px-1.5 py-0.5 rounded text-xs font-medium">
            {framework}
          </span>
        )}
      </div>

      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}

      {result && (
        <div
          className={`rounded p-2 text-xs ${
            isError
              ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
              : 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200'
          }`}
        >
          {result}
        </div>
      )}
    </div>
  )
}

export const createDashboardRenderer: ToolRenderer = {
  displayName: 'Create Dashboard',
  icon: LayoutDashboard,
  getSummary: (input) => {
    const { name, framework } = input as CreateDashboardInput
    if (!name) return null
    return framework ? `${name} (${framework})` : name
  },
  ExpandedView: CreateDashboardExpandedView,
}

// ── start_dashboard ───────────────────────────────────────────

export const startDashboardRenderer: ToolRenderer = {
  displayName: 'Start Dashboard',
  icon: Play,
  getSummary: (input) => {
    const { slug } = input as DashboardSlugInput
    return slug ?? null
  },
}

// ── list_dashboards ───────────────────────────────────────────

export const listDashboardsRenderer: ToolRenderer = {
  displayName: 'List Dashboards',
  icon: List,
}

// ── get_dashboard_logs ────────────────────────────────────────

function DashboardLogsExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug, clear } = input as DashboardSlugInput

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        {slug && (
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{slug}</code>
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
            className={`rounded p-2 text-xs overflow-x-auto max-h-60 overflow-y-auto font-mono ${
              isError
                ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
                : 'bg-background'
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
  displayName: 'Dashboard Logs',
  icon: ScrollText,
  getSummary: (input) => {
    const { slug } = input as DashboardSlugInput
    return slug ?? null
  },
  ExpandedView: DashboardLogsExpandedView,
}
