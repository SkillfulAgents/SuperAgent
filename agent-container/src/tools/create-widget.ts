import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { widgetManager, DEFAULT_WIDGET_SCRIPT_COMMAND } from '../widget-manager'
import { WIDGET_SIZES } from '../widget-schema'

export const WIDGET_GUIDANCE_HINT =
  'Required guidance: load the `widgets` skill before editing or refreshing this widget (unless you already loaded it in this conversation).'

export const createWidgetTool = tool(
  'create_widget',
  `Give an artifact a home-screen widget: a small glanceable card (one number, a next event, a few KPIs) rendered from a static widget.html that a widget.ts script rewrites with fresh data — no conversation involved.

- slug of an EXISTING dashboard → the widget is added to that dashboard's artifact (tapping the widget opens the dashboard; the widget script can reuse the dashboard's data code).
- new slug → a widget-only artifact is scaffolded at /workspace/artifacts/<slug>/.

After creating, edit widget.html / widget.ts, then call refresh_widget to render it and check the preview.

Arguments:
- slug: URL-safe identifier (an existing dashboard slug, or a new one like "daily-macros")
- name / description: used only when scaffolding a new artifact
- size: "small" (square, default) or "medium" (2:1 landscape)
- withScript: include the widget.ts refresh script and the scripts.widget entry that runs it (default true). Set false for a widget you rewrite yourself during a run.
- refreshOnTurnEnd: re-render after EVERY turn you finish, not only once the script's validUntil has passed (default false). Use it when the data is something you change in conversation (a task list, a food log, a running tally), so the card is never behind the chat.`,
  {
    slug: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug must be lowercase alphanumeric with hyphens, not starting/ending with hyphen')
      .describe('Artifact slug: an existing dashboard, or a new widget-only artifact'),
    name: z.string().describe('Human-readable name (new artifacts only)'),
    description: z.string().optional().describe('What the widget shows (new artifacts only)'),
    size: z.enum(WIDGET_SIZES).optional().describe('"small" (square) or "medium" (2:1)'),
    withScript: z.boolean().optional().describe('Scaffold widget.ts (default true)'),
    refreshOnTurnEnd: z.boolean().optional().describe('Re-render after every turn you finish (default false)'),
  },
  async (args) => {
    try {
      const { dir, addedToDashboard, kept } = await widgetManager.createWidget(args.slug, args.name, args.description || '', {
        size: args.size,
        withScript: args.withScript,
        refreshOnTurnEnd: args.refreshOnTurnEnd,
      })
      return {
        content: [
          {
            type: 'text' as const,
            text:
              (addedToDashboard
                ? `Widget added to the "${args.slug}" dashboard at ${dir}/ — tapping it opens that dashboard.\n\n`
                : `Widget-only artifact "${args.name}" created at ${dir}/\n\n`) +
              `Files: package.json (gamut.widget block${args.refreshOnTurnEnd ? ', refreshOnTurnEnd: true — re-rendered after every turn you finish' : ''}${args.withScript === false ? '' : `, scripts.widget = "${DEFAULT_WIDGET_SCRIPT_COMMAND}"`}), widget.html (the snapshot)` +
              `${args.withScript === false ? '' : ', widget.ts (refresh script — rewrite widget.html from fresh data and write widget.json with validUntil)'}.\n\n` +
              (kept.length > 0
                ? `${kept.join(' and ')} already existed and ${kept.length === 1 ? 'was' : 'were'} left untouched — the template did NOT overwrite ${kept.length === 1 ? 'it' : 'them'}. Read ${kept.length === 1 ? 'it' : 'them'} before editing.\n\n`
                : '') +
              `Edit them, then call refresh_widget to render and preview.\n\n${WIDGET_GUIDANCE_HINT}`,
          },
        ],
      }
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error creating widget: ${error.message}` }],
        isError: true,
      }
    }
  },
)
