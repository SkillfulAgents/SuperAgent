import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { dashboardManager } from '../dashboard-manager'

export const createDashboardTool = tool(
  'create_dashboard',
  `Scaffold a new dashboard project at /workspace/artifacts/<slug>/. This creates the directory structure, package.json, and starter code.

After creating, use start_dashboard to start the server.

Arguments:
- slug: URL-safe identifier for the dashboard (e.g., "sales-dashboard")
- name: Human-readable name for the dashboard
- description: Optional description of what the dashboard shows
- framework: "plain" (default) for plain HTML+JS using Bun.serve(), or "react" for a React + Vite setup`,
  {
    slug: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug must be lowercase alphanumeric with hyphens, not starting/ending with hyphen')
      .describe('URL-safe identifier for the dashboard'),
    name: z.string().describe('Human-readable name for the dashboard'),
    description: z.string().optional().describe('Description of what the dashboard shows'),
    framework: z
      .enum(['plain', 'react'])
      .optional()
      .describe('Framework to use: "plain" (Bun.serve) or "react" (React + Vite)'),
  },
  async (args) => {
    try {
      await dashboardManager.createDashboard(
        args.slug,
        args.name,
        args.description || '',
        args.framework || 'plain'
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: `Dashboard "${args.name}" created at /workspace/artifacts/${args.slug}/\n\nYou can now edit the source files and use start_dashboard to start the server.`,
          },
        ],
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error creating dashboard: ${error.message}`,
          },
        ],
        isError: true,
      }
    }
  }
)
