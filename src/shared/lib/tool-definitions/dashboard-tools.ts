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
  displayName: 'Create Dashboard',
  getSummary: (input) => {
    const { name, framework } = input as CreateDashboardInput
    if (!name) return null
    return framework ? `${name} (${framework})` : name
  },
}

export const startDashboardDef: ToolDefinition = {
  displayName: 'Start Dashboard',
  getSummary: (input) => (input as DashboardSlugInput).slug ?? null,
}

export const listDashboardsDef: ToolDefinition = {
  displayName: 'List Dashboards',
  getSummary: () => null,
}

export const getDashboardLogsDef: ToolDefinition = {
  displayName: 'Dashboard Logs',
  getSummary: (input) => (input as DashboardSlugInput).slug ?? null,
}
