import type { ToolDefinition } from './types'

export interface CreateDashboardInput {
  slug?: string
  name?: string
  description?: string
  framework?: 'plain' | 'react'
}

export interface DashboardSlugInput {
  slug?: string
  clear?: boolean
}

export const createDashboardDef: ToolDefinition = {
  displayName: 'Create Dashboard', iconName: 'LayoutDashboard',
  getSummary: (input) => {
    const { name, framework } = input as CreateDashboardInput
    if (!name) return null
    return framework ? `${name} (${framework})` : name
  },
}

export const startDashboardDef: ToolDefinition = {
  displayName: 'Start Dashboard', iconName: 'Play',
  getSummary: (input) => (input as DashboardSlugInput).slug ?? null,
}

export const listDashboardsDef: ToolDefinition = {
  displayName: 'List Dashboards', iconName: 'List',
  getSummary: () => null,
}

export const getDashboardLogsDef: ToolDefinition = {
  displayName: 'Dashboard Logs', iconName: 'ScrollText',
  getSummary: (input) => (input as DashboardSlugInput).slug ?? null,
}
