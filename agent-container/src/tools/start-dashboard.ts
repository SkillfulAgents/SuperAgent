import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { dashboardManager } from '../dashboard-manager'

export const startDashboardTool = tool(
  'start_dashboard',
  `Start a dashboard server, or restart it if already running. Use this after creating a new dashboard or after making code changes.

The dashboard must exist at /workspace/artifacts/<slug>/ with a valid package.json.`,
  {
    slug: z.string().describe('The slug of the dashboard to start'),
  },
  async (args) => {
    try {
      const info = await dashboardManager.startDashboard(args.slug)

      let text = `Dashboard "${info.name}" is ${info.status} on port ${info.port}.`

      if (info.status === 'running') {
        text += '\n\nThe dashboard is accessible to the user through the Superagent UI.'
      } else if (info.status === 'crashed' || info.status === 'stopped') {
        // Include recent logs so the agent can debug without a separate tool call
        const logs = await dashboardManager.getDashboardLogs(args.slug)
        if (logs) {
          const recentLogs = logs.length > 3000 ? logs.slice(-3000) : logs
          text += `\n\nRecent logs:\n${recentLogs}`
        } else {
          text += '\n\nNo logs were captured. The process may have failed to spawn.'
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error starting dashboard: ${error.message}`,
          },
        ],
        isError: true,
      }
    }
  }
)
