import { tool } from '@anthropic-ai/claude-agent-sdk'
import { widgetManager } from '../widget-manager'

export const listWidgetsTool = tool(
  'list_widgets',
  `List the artifacts that expose a home-screen widget: slug, name, size, whether the same artifact is also a dashboard, whether a refresh script exists, and when the current snapshot was generated / expires.`,
  {},
  async () => {
    try {
      const widgets = widgetManager.listWidgets()
      if (widgets.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No widgets found. Use create_widget to add one to a dashboard or scaffold a widget-only artifact.' }],
        }
      }
      const summary = widgets
        .map((w) => {
          const snap = w.snapshot
          const state = !snap
            ? 'never refreshed'
            : snap.lastError
              ? `last refresh failed: ${snap.lastError}`
              : `generated ${snap.generatedAt}${snap.validUntil ? `, valid until ${snap.validUntil}` : ', never expires'}`
          return `- ${w.name} (${w.slug}): ${w.size}${w.hasDashboard ? ', also a dashboard' : ', widget-only'}${w.hasScript ? ', has refresh script' : ', static'}${w.refreshOnTurnEnd ? ', re-renders after every turn' : ''} — ${state}${w.description ? ` — ${w.description}` : ''}`
        })
        .join('\n')
      return { content: [{ type: 'text' as const, text: `Widgets:\n${summary}` }] }
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error listing widgets: ${error.message}` }],
        isError: true,
      }
    }
  },
)
