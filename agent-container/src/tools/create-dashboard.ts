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

      const reactNote =
        args.framework === 'react'
          ? 'src/tokens.css (CSS custom properties + .sa-card/.sa-button/.sa-badge/.sa-input recipes) and src/App.jsx'
          : 'index.js (the <style> block at the top defines the design tokens)'

      return {
        content: [
          {
            type: 'text' as const,
            text: `Dashboard "${args.name}" created at /workspace/artifacts/${args.slug}/

REQUIRED before editing any files:
1. Read /workspace/artifacts/${args.slug}/DESIGN.md — it defines the design system this dashboard inherits (colors, type scale, spacing, component recipes, dark mode rules).
2. Build on top of the existing token system in ${reactNote}. Do NOT delete or replace the token block, do NOT introduce a parallel set of CSS variables, do NOT load external fonts (Google Fonts, etc.), do NOT hardcode hex colors in component code — use var(--color-*), var(--space-*), var(--text-*), var(--font-sans).
3. If you genuinely need a value the system doesn't provide, override it in DESIGN.md first, then mirror it in the stylesheet.

Then use start_dashboard to start the server.`,
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
