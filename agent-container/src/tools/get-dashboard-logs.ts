import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { dashboardManager } from '../dashboard-manager'

export const getDashboardLogsTool = tool(
  'get_dashboard_logs',
  `Get the stdout/stderr logs from a dashboard server. Useful for debugging when a dashboard crashes or misbehaves.

Optionally clear the log file after reading.`,
  {
    slug: z.string().describe('The slug of the dashboard to get logs for'),
    clear: z
      .boolean()
      .optional()
      .describe('If true, truncate the log file after reading'),
  },
  async (args) => {
    try {
      const logs = await dashboardManager.getDashboardLogs(
        args.slug,
        args.clear ?? false
      )

      if (!logs) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No logs found for dashboard "${args.slug}".`,
            },
          ],
        }
      }

      // Truncate if very long
      const maxLength = 10000
      const truncated = logs.length > maxLength
      const output = truncated ? logs.slice(-maxLength) : logs

      return {
        content: [
          {
            type: 'text' as const,
            text: `${truncated ? '...(truncated, showing last 10000 chars)\n' : ''}${output}${args.clear ? '\n\n[Log file cleared]' : ''}`,
          },
        ],
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error getting logs: ${error.message}`,
          },
        ],
        isError: true,
      }
    }
  }
)
