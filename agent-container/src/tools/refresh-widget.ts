import * as fs from 'fs'
import * as path from 'path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ARTIFACTS_DIR } from '../dashboard-manager'
import { widgetManager, SNAPSHOTS_DIRNAME } from '../widget-manager'
import {
  FALLBACK_VALIDITY_SECONDS,
  WIDGET_HTML_FILENAME,
  WIDGET_META_FILENAME,
  WIDGET_SCHEMES,
  WIDGET_SIZES,
  snapshotFileName,
  type WidgetScale,
  type WidgetScheme,
  type WidgetSize,
} from '../widget-schema'

type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** The scale the previews are returned at; 3x exists on disk for iOS only. */
const PREVIEW_SCALE: WidgetScale = 2

async function htmlHasScriptTag(slug: string): Promise<boolean> {
  try {
    const html = await fs.promises.readFile(path.join(ARTIFACTS_DIR, slug, WIDGET_HTML_FILENAME), 'utf-8')
    return /<script[\s>]/i.test(html)
  } catch {
    return false
  }
}

/**
 * Which renders come back as images. The declared size in both schemes is the
 * default: dark mode is where widgets break most often and the agent cannot
 * see it any other way.
 */
function previewTargets(declared: WidgetSize, mode: 'declared' | 'all'): Array<{ size: WidgetSize; scheme: WidgetScheme }> {
  const sizes = mode === 'all' ? [...WIDGET_SIZES] : [declared]
  return sizes.flatMap((size) => WIDGET_SCHEMES.map((scheme) => ({ size, scheme })))
}

export const refreshWidgetTool = tool(
  'refresh_widget',
  `Refresh an artifact's widget: run its widget script (if any), re-render widget.html into PNG snapshots, and return those renders so you can check your own work. This is how you QA a widget — the images are the real files the user's home screens and phone show, not an approximation.

By default you get the widget's declared size in light AND dark. Pass previews:"all" for both size families, or previews:"none" to skip the images (paths are always listed).

The artifact at /workspace/artifacts/<slug>/ must have a gamut.widget block in package.json.`,
  {
    slug: z.string().describe('The artifact slug whose widget to refresh'),
    previews: z
      .enum(['declared', 'all', 'none'])
      .optional()
      .describe('Which renders to return as images: "declared" size (default), "all" sizes, or "none"'),
  },
  async (args) => {
    try {
      const info = widgetManager.getWidget(args.slug)
      if (!info) {
        return {
          content: [{ type: 'text' as const, text: `/workspace/artifacts/${args.slug}/ does not expose a widget. Use create_widget first.` }],
          isError: true,
        }
      }
      const snapshot = await widgetManager.refreshWidget(args.slug)
      const content: ToolContentBlock[] = []
      const warnings: string[] = []
      // Scripts never run where the widget is displayed (sandboxed iframe,
      // CSP, PNG). Anything they would have drawn is missing there, so flag
      // it at the agent's verification touchpoint.
      if (await htmlHasScriptTag(args.slug)) {
        warnings.push(`WARNING: ${WIDGET_HTML_FILENAME} contains a <script> tag. Scripts do NOT run where the widget is shown — move that logic into the widget script and bake the result into the HTML.`)
      }
      if (snapshot.scriptRan && !snapshot.lastError && snapshot.validityDefaulted) {
        warnings.push(`WARNING: the script did not write a valid ${WIDGET_META_FILENAME} ({ "validUntil": ISO-8601 | null }), so the platform assumed ${FALLBACK_VALIDITY_SECONDS / 60} minutes. Compute a real validUntil from the data (e.g. next market open, next calendar event, tomorrow morning).`)
      }
      let text: string
      if (snapshot.lastError) {
        text = `Widget "${info.name}" refresh FAILED: ${snapshot.lastError}`
        const logs = await widgetManager.getWidgetLogs(args.slug)
        if (logs) text += `\n\nRecent log:\n${logs.length > 3000 ? logs.slice(-3000) : logs}`
        text += `\n\nFix the script or ${WIDGET_HTML_FILENAME} and refresh again.`
      } else {
        text =
          `Widget "${info.name}" refreshed in ${snapshot.durationMs}ms` +
          `${snapshot.scriptRan ? ' (script ran)' : ' (no script — static HTML)'}.` +
          `${snapshot.validUntil ? ` Valid until ${snapshot.validUntil}.` : snapshot.scriptRan ? '' : ' Static: only changes when you rewrite it.'}` +
          `${info.refreshOnTurnEnd ? ' It also re-renders after every turn you finish.' : ''}` +
          ` The user sees it on this agent's home page and the app home${info.hasDashboard ? ' in place of the dashboard screenshot' : ''}.`

        if (snapshot.renderedSizes.length === 0) {
          text += '\n\n(No PNG snapshots could be rendered — the HTML snapshot still shows in the app, but you cannot check it visually here.)'
        } else {
          // Every file that exists on disk, so the agent can Read any of them
          // directly (including the 3x renders the phone uses).
          const paths = snapshot.renderedSizes
            .map((name) => path.join(ARTIFACTS_DIR, args.slug, SNAPSHOTS_DIRNAME, `${name}.png`))
            .sort()
          text += `\n\nRendered ${paths.length} PNG${paths.length === 1 ? '' : 's'}:\n${paths.map((p) => `- ${p}`).join('\n')}`

          const mode = args.previews ?? 'declared'
          if (mode === 'none') {
            text += '\n\nNo previews attached (previews: "none"). Read any path above to look at one.'
          } else {
            const attached: string[] = []
            const missing: string[] = []
            for (const { size, scheme } of previewTargets(info.size, mode)) {
              const baseName = snapshotFileName(size, scheme, PREVIEW_SCALE).replace(/\.png$/, '')
              // Only ask for renders this refresh actually produced.
              if (!snapshot.renderedSizes.includes(baseName)) continue
              const file = path.join(ARTIFACTS_DIR, args.slug, SNAPSHOTS_DIRNAME, `${baseName}.png`)
              try {
                const buf = await fs.promises.readFile(file)
                content.push({ type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' })
                attached.push(`${size} ${scheme}`)
              } catch (err: unknown) {
                missing.push(`${size} ${scheme} (${err instanceof Error ? err.message : String(err)})`)
              }
            }
            if (attached.length > 0) {
              text +=
                `\n\nAttached below, in order: ${attached.join(', ')} (at ${PREVIEW_SCALE}x).` +
                ` Check each one: does it read in under two seconds, is there one clear focal value, no clipped text, no scrollbars, no empty regions` +
                `${attached.some((a) => a.endsWith('dark')) ? ', and does the dark render have real dark-mode colours rather than the light palette' : ''}?`
            }
            if (missing.length > 0) text += `\n\n(Could not read: ${missing.join('; ')}.)`
          }
        }
      }
      if (warnings.length > 0) text += `\n\n${warnings.join('\n\n')}`
      content.unshift({ type: 'text' as const, text })
      return { content, ...(snapshot.lastError ? { isError: true } : {}) }
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error refreshing widget: ${error.message}` }],
        isError: true,
      }
    }
  },
)
