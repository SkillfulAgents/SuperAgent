import { z } from 'zod'

/**
 * Widget contract (container side). The host keeps a mirror in
 * src/shared/lib/widgets/widget-schema.ts — agent-container cannot import
 * @shared, so any change here must be made there too.
 *
 * An artifact (a directory under /workspace/artifacts) is one unit that may
 * expose a dashboard (a `start` script), a widget (a `gamut.widget` block),
 * or both. Both halves are run the same way — `bun run start` for the
 * dashboard, `bun run widget` for the widget — so the manifest reads:
 *   scripts.widget — the command that regenerates the snapshot (optional:
 *                    without it the widget is static)
 *   gamut.widget   — { size?, timeoutSeconds?, refreshOnTurnEnd? }: what the
 *                    platform needs to know, and the marker that says this
 *                    artifact exposes a widget at all
 *   widget.ts      — what scripts.widget conventionally runs
 *   widget.html    — the snapshot the script writes: static, responsive, data baked in
 *   widget.json    — the script's sidecar: { validUntil } — the script decides
 *                    how long its own output stays true
 *   snapshots/     — platform-owned rasterizer output + snapshot.json
 */

export const WIDGET_SIZES = ['small', 'medium'] as const
export type WidgetSize = (typeof WIDGET_SIZES)[number]

export const WIDGET_SCHEMES = ['light', 'dark'] as const
export type WidgetScheme = (typeof WIDGET_SCHEMES)[number]

export const WIDGET_SCALES = [2, 3] as const
export type WidgetScale = (typeof WIDGET_SCALES)[number]

/** CSS-pixel viewport of each family (the iOS small/medium footprints). */
export const WIDGET_FAMILY_VIEWPORTS: Record<WidgetSize, { width: number; height: number }> = {
  small: { width: 170, height: 170 },
  medium: { width: 364, height: 170 },
}

/**
 * The policy the app renders a widget under. Mirrored by hand from
 * `src/shared/lib/services/widget-service.ts` (this package cannot import
 * @shared), and stamped into the document before rasterizing so a PNG cannot
 * show what the app would refuse to load — a sibling stylesheet or image, say,
 * which no HTTP policy blocks because it never crosses the network.
 */
export const WIDGET_DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

/** The document as the app renders it: scheme stamped, policy inlined. */
export function renderWidgetDocument(html: string, scheme: WidgetScheme): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${WIDGET_DOCUMENT_CSP}">`
  // Keep this prefix in sync with the host helper: the policy must be parsed
  // before authored comments, attributes, templates, or raw-text elements.
  // Leave the head open for authored metadata and styles; later html tags
  // merge their attributes without replacing the platform's data-theme.
  return `<!DOCTYPE html><html data-theme="${scheme}"><head>${meta}${html}`
}

export const WIDGET_HTML_FILENAME = 'widget.html'
export const WIDGET_META_FILENAME = 'widget.json'

/** Used when the script writes no widget.json — a widget must expire somehow. */
export const FALLBACK_VALIDITY_SECONDS = 60 * 60
export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 30
export const MAX_SCRIPT_TIMEOUT_SECONDS = 120

/**
 * Every field falls back to its default rather than failing the parse: this
 * object decides whether the artifact HAS a widget at all, so one bad value
 * ("size": "large") would otherwise reclassify the artifact as a dashboard and
 * the widget would silently disappear from both sides. Out-of-range timeouts
 * are clamped where the script is run, not rejected here — see widget-manager.
 */
export const WidgetConfigSchema = z
  .object({
    size: z.enum(WIDGET_SIZES).optional().catch(undefined),
    timeoutSeconds: z.number().int().min(1).optional().catch(undefined),
    /**
     * Re-render after every turn the agent finishes, regardless of
     * validUntil. For widgets whose data the agent itself changes during a
     * conversation (a task list, a food log). Default: only when stale.
     */
    refreshOnTurnEnd: z.boolean().optional().catch(undefined),
  })
  .passthrough()
export type WidgetConfig = z.infer<typeof WidgetConfigSchema>

/** The whole artifact manifest, as far as the widget side cares. */
export const ArtifactPackageSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    scripts: z
      .object({
        /** Runs the dashboard server. */
        start: z.string().optional(),
        /** Regenerates widget.html + widget.json. Absent → static widget. */
        widget: z.string().optional(),
      })
      .passthrough()
      .optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    gamut: z
      .object({
        widget: WidgetConfigSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type ArtifactPackage = z.infer<typeof ArtifactPackageSchema>

/** What the refresh script writes next to widget.html. */
export const WidgetMetaSchema = z.object({
  validUntil: z.string().datetime({ offset: true }).nullable(),
})
export type WidgetMeta = z.infer<typeof WidgetMetaSchema>

export const WidgetSnapshotSchema = z.object({
  generatedAt: z.string(),
  /** From the script's widget.json; null = never expires on its own. */
  validUntil: z.string().nullable(),
  /** True when validUntil came from the platform fallback, not the script. */
  validityDefaulted: z.boolean(),
  htmlHash: z.string(),
  renderedSizes: z.array(z.string()),
  scriptRan: z.boolean(),
  durationMs: z.number(),
  lastError: z.string().nullable(),
})
export type WidgetSnapshot = z.infer<typeof WidgetSnapshotSchema>

export const WidgetInfoSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  size: z.enum(WIDGET_SIZES),
  /** The same artifact also serves a dashboard (has a start script). */
  hasDashboard: z.boolean(),
  hasScript: z.boolean(),
  hasHtml: z.boolean(),
  refreshOnTurnEnd: z.boolean(),
  snapshot: WidgetSnapshotSchema.nullable(),
})
export type WidgetInfo = z.infer<typeof WidgetInfoSchema>

export function snapshotFileName(size: WidgetSize, scheme: WidgetScheme, scale: WidgetScale): string {
  return `${size}-${scheme}@${scale}x.png`
}
