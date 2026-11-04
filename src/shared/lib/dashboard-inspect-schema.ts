import { z } from 'zod'

/**
 * Dashboard inspection protocol: what the app asks of a dashboard frame when
 * the person leaves a comment on it.
 *
 * The inspector (`src/api/dashboard-inspector.ts`) is injected into every
 * proxied dashboard document ahead of its own scripts. From then on it keeps
 * the page's recent console output, uncaught errors and failed requests. The
 * host asks it for a snapshot (the page's URL, viewport, selection, the
 * element under the comment's pin, and that log) and gets one reply.
 *
 * It also offers the host the frame's right-click: once the host says it takes
 * comments, a right-click outside a text field (with no text selected, and
 * without Shift) is posted to the host, which shows its own menu there.
 *
 * Every message crosses frames, so both sides check the sender's window and
 * the host validates each reply here. A frame that never answers (a dashboard
 * served before the inspector existed) is waited on for a moment, then the
 * comment goes without it.
 */

export const DASHBOARD_INSPECT_REQUEST_TYPE = 'gamut:dashboard-inspect-request'
export const DASHBOARD_INSPECT_RESULT_TYPE = 'gamut:dashboard-inspect-result'
export const DASHBOARD_HOST_FEATURES_TYPE = 'gamut:dashboard-host-features'
export const DASHBOARD_CONTEXT_MENU_TYPE = 'gamut:dashboard-context-menu'

/** Entries the frame keeps; older ones fall off. */
export const DASHBOARD_LOG_CAPACITY = 200
/** Characters kept of one entry. */
export const DASHBOARD_LOG_ENTRY_MAX = 1000

export const dashboardLogEntrySchema = z.object({
  /** `network` is a request that failed or answered 4xx/5xx; `resource` an asset that failed to load. */
  level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'network', 'resource']),
  /** Epoch milliseconds. */
  at: z.number(),
  text: z.string().max(DASHBOARD_LOG_ENTRY_MAX + 1),
})
export type DashboardLogEntry = z.infer<typeof dashboardLogEntrySchema>

export const dashboardElementSchema = z.object({
  /** `div#total.card.wide` */
  tag: z.string().max(300),
  /** Up to five ancestors down to the element, `main > section.grid > div.card`. */
  path: z.string().max(1000),
  /** The element's own visible text, trimmed and capped. */
  text: z.string().max(400),
  /** The text of the nearest ancestor with a sentence's worth, for a bare number or an icon. */
  context: z.string().max(600).optional(),
  role: z.string().max(100).optional(),
  label: z.string().max(300).optional(),
  /** In the frame's CSS pixels. */
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
})
export type DashboardElement = z.infer<typeof dashboardElementSchema>

export const dashboardSnapshotSchema = z.object({
  url: z.string().max(4000),
  /** The dashboard's mount, as the runtime reports it: `/api/agents/a/artifacts/d/`. */
  basePath: z.string().max(1000).optional(),
  title: z.string().max(500),
  viewport: z.object({ width: z.number(), height: z.number() }),
  scroll: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  devicePixelRatio: z.number(),
  selection: z.string().max(2000),
  element: dashboardElementSchema.nullable(),
  logs: z.array(dashboardLogEntrySchema).max(DASHBOARD_LOG_CAPACITY),
  /** Entries that fell off the front since the page loaded. */
  droppedLogs: z.number(),
  /** Entries per level since the page loaded, dropped ones included. */
  counts: z.record(z.string(), z.number()).optional(),
})
export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>

export const dashboardInspectResultSchema = z.object({
  type: z.literal(DASHBOARD_INSPECT_RESULT_TYPE),
  id: z.string().min(1).max(128),
  snapshot: dashboardSnapshotSchema,
})

export const dashboardContextMenuSchema = z.object({
  type: z.literal(DASHBOARD_CONTEXT_MENU_TYPE),
  /** In the frame's CSS pixels. */
  x: z.number(),
  y: z.number(),
})
