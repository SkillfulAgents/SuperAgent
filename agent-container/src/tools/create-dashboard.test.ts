import { afterEach, describe, expect, it, vi } from 'vitest'
import { dashboardManager } from '../dashboard-manager'
import { createDashboardTool, DASHBOARD_GUIDANCE_HINT } from './create-dashboard'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('create_dashboard guidance', () => {
  it('returns the dashboard guide after scaffolding', async () => {
    vi.spyOn(dashboardManager, 'createDashboard').mockResolvedValue(undefined)

    const result = await (createDashboardTool as any).handler({
      slug: 'sales-dashboard',
      name: 'Sales Dashboard',
      description: 'Sales metrics',
      framework: 'react',
    })

    expect(dashboardManager.createDashboard).toHaveBeenCalledWith(
      'sales-dashboard',
      'Sales Dashboard',
      'Sales metrics',
      'react',
    )
    expect(result.content[0].text).toContain(DASHBOARD_GUIDANCE_HINT)
  })
})
