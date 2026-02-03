import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { dashboardManager } from '../dashboard-manager'

export const listDashboardsTool = tool(
  'list_dashboards',
  `List all dashboards created by the agent. Returns each dashboard's slug, name, description, status, and port.`,
  {},
  async () => {
    try {
      const dashboards = dashboardManager.listDashboards()

      if (dashboards.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No dashboards found. Use create_dashboard to create one.',
            },
          ],
        }
      }

      const summary = dashboards
        .map(
          (d) =>
            `- ${d.name} (${d.slug}): ${d.status}${d.port ? ` on port ${d.port}` : ''}${d.description ? ` — ${d.description}` : ''}`
        )
        .join('\n')

      return {
        content: [
          {
            type: 'text' as const,
            text: `Dashboards:\n${summary}`,
          },
        ],
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error listing dashboards: ${error.message}`,
          },
        ],
        isError: true,
      }
    }
  }
)
