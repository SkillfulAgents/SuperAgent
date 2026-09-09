import { z } from 'zod'

/**
 * Widget contract (host side). Mirrors agent-container/src/widget-schema.ts —
 * the container package cannot import @shared, so keep the two in step.
 *
 * An artifact (<workspace>/artifacts/<slug>/) is one unit that may expose a
 * dashboard (a `start` script), a widget (a `gamut.widget` block), or both.
 * Each half is run by its named script: `bun run start`, `bun run widget`.
 *   scripts.widget — regenerates the snapshot; absent → the widget is static
 *   widget.ts      — what that script conventionally runs
 *   widget.html    — the snapshot: static, responsive, data baked in
 *   widget.json    — the script's verdict on validity: { validUntil }
 *   snapshots/     — rasterized PNGs + snapshot.json written by the container
 */

export const WIDGET_SIZES = ['small', 'medium'] as const
export type WidgetSize = (typeof WIDGET_SIZES)[number]
export const widgetSizeSchema = z.enum(WIDGET_SIZES)

export const WIDGET_SCHEMES = ['light', 'dark'] as const
export type WidgetScheme = (typeof WIDGET_SCHEMES)[number]
export const widgetSchemeSchema = z.enum(WIDGET_SCHEMES)

export const WIDGET_SCALES = [2, 3] as const
export type WidgetScale = (typeof WIDGET_SCALES)[number]

export const WIDGET_HTML_FILENAME = 'widget.html'
export const WIDGET_META_FILENAME = 'widget.json'

/**
 * Mirrors the container's WidgetConfigSchema, including the `.catch()` on
 * every field: this object is the marker that says the artifact has a widget,
 * so a value the schema dislikes must degrade to the default instead of
 * failing the parse and making the widget vanish from the listing.
 */
export const widgetConfigSchema = z
  .object({
    size: widgetSizeSchema.optional().catch(undefined),
    timeoutSeconds: z.number().int().positive().optional().catch(undefined),
    /** Re-render after every turn the agent finishes, not only when stale. */
    refreshOnTurnEnd: z.boolean().optional().catch(undefined),
  })
  .passthrough()
export type WidgetConfig = z.infer<typeof widgetConfigSchema>

/** The artifact manifest, as far as the host cares. */
export const artifactPackageSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    scripts: z
      .object({ start: z.string().optional(), widget: z.string().optional() })
      .passthrough()
      .optional(),
    gamut: z.object({ widget: widgetConfigSchema.optional() }).passthrough().optional(),
  })
  .passthrough()
export type ArtifactPackage = z.infer<typeof artifactPackageSchema>

export interface ArtifactShape {
  isDashboard: boolean
  widget: WidgetConfig | null
}

/**
 * Same rule as the container's artifact-kind.ts: a dashboard has a start
 * script (or is a legacy manifest with no widget block at all); a widget is
 * a `gamut.widget` block. An unparseable manifest counts as a dashboard so
 * nothing that used to be listed disappears.
 */
export function artifactShapeOf(pkg: unknown): ArtifactShape {
  const parsed = artifactPackageSchema.safeParse(pkg)
  if (!parsed.success) return { isDashboard: true, widget: null }
  const widget = parsed.data.gamut?.widget ?? null
  const hasStart = typeof parsed.data.scripts?.start === 'string' && parsed.data.scripts.start.length > 0
  return { isDashboard: hasStart || widget === null, widget }
}

export const widgetSnapshotSchema = z.object({
  generatedAt: z.string(),
  validUntil: z.string().nullable(),
  validityDefaulted: z.boolean(),
  htmlHash: z.string(),
  renderedSizes: z.array(z.string()),
  scriptRan: z.boolean(),
  durationMs: z.number(),
  lastError: z.string().nullable(),
})
export type WidgetSnapshot = z.infer<typeof widgetSnapshotSchema>

/** What the container returns from POST /artifacts/:slug/widget/refresh. */
export const containerWidgetRefreshResponseSchema = widgetSnapshotSchema

/** Body of the container → host `widget-snapshot-ready` event. */
export const widgetSnapshotReadyEventSchema = z.object({
  widgetSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  generatedAt: z.string(),
  validUntil: z.string().nullable(),
  htmlHash: z.string(),
  error: z.string().nullable(),
})

/** Wire shape of one widget in GET /api/agents/:id/widgets and ApiAgent.widgets. */
export interface ApiAgentWidget {
  /** Artifact slug — the same slug as the dashboard when the artifact has one. */
  slug: string
  name: string
  description: string
  size: WidgetSize
  /** The artifact also serves a dashboard; tapping the widget opens it. */
  hasDashboard: boolean
  hasScript: boolean
  /** A widget.html exists — the in-app iframe has something to show. */
  hasHtml: boolean
  /** Hash of the current widget.html; the iframe URL carries it as a cache key. */
  htmlHash: string | null
  /** Manifest opt-in: the after-run sweep re-renders it after every turn. */
  refreshOnTurnEnd: boolean
  generatedAt: string | null
  validUntil: string | null
  lastError: string | null
  /** Snapshot is missing, expired, or behind the current widget.html. */
  isStale: boolean
  /** A refresh is running for this widget right now (host-side view). */
  refreshing: boolean
}

export function snapshotFileName(size: WidgetSize, scheme: WidgetScheme, scale: WidgetScale): string {
  return `${size}-${scheme}@${scale}x.png`
}

/**
 * Stale = something to refresh: no snapshot yet, the HTML changed since the
 * snapshot was taken (an agent run rewrote it), or the script's validUntil
 * has passed. A scriptless widget with a current hash is never stale —
 * nothing would change by re-running.
 */
export function isWidgetStale(
  widget: { hasHtml: boolean; hasScript: boolean; htmlHash: string | null },
  snapshot: WidgetSnapshot | null,
  now: number = Date.now(),
): boolean {
  if (!widget.hasHtml && !widget.hasScript) return false
  if (!snapshot) return true
  if (widget.htmlHash !== null && snapshot.htmlHash !== widget.htmlHash) return true
  if (snapshot.validUntil === null) return false
  const validUntil = Date.parse(snapshot.validUntil)
  return Number.isNaN(validUntil) || validUntil <= now
}
