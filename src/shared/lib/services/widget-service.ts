import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import pLimit from 'p-limit'
import { agentRegistry } from '@shared/lib/agent-actor'
import { isRealPathWithinDir } from '@shared/lib/utils/path-safety'
import {
  WIDGET_HTML_FILENAME,
  artifactPackageSchema,
  artifactShapeOf,
  isWidgetStale,
  snapshotFileName,
  widgetSnapshotSchema,
  type ApiAgentWidget,
  type WidgetScale,
  type WidgetScheme,
  type WidgetSize,
  type WidgetSnapshot,
} from '@shared/lib/widgets/widget-schema'

export const WIDGET_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const SNAPSHOTS_DIRNAME = 'snapshots'
const SNAPSHOT_META_FILENAME = 'snapshot.json'
const WIDGET_LOG_FILENAME = 'widget.log'

/** Same 16-hex-char sha256 prefix the container writes into snapshot.json. */
export function hashWidgetHtml(html: string | Buffer): string {
  return createHash('sha256').update(html).digest('hex').slice(0, 16)
}

/**
 * True for an artifact that exposes only a widget (no start script). The
 * dashboard lister skips these — the two kinds share artifacts/.
 */
export function isWidgetOnlyArtifact(pkg: unknown): boolean {
  return !artifactShapeOf(pkg).isDashboard
}

export function artifactsDirFor(agentSlug: string): string {
  return path.join(agentRegistry.get(agentSlug).files.workspacePath(), 'artifacts')
}

/**
 * Absolute path of a file inside an artifact dir, or null when the slug or
 * file would escape <workspace>/artifacts. Every route that touches disk
 * goes through here.
 *
 * Containment is symlink-aware. The artifact dir lives in the workspace the
 * agent's container bind-mounts, so the agent can plant a link there: a
 * string-only check passes `widget.html -> /etc/passwd` and the host serves
 * whatever it points at, under the caller's permission to read their own
 * agent. `isRealPathWithinDir` fails closed on any fs error, and a dangling
 * link resolves to its contained parent and reads as absent downstream.
 */
export function resolveWidgetPath(agentSlug: string, artifactSlug: string, ...segments: string[]): string | null {
  if (!WIDGET_SLUG_REGEX.test(artifactSlug)) return null
  const artifactsDir = artifactsDirFor(agentSlug)
  // `artifacts` is itself something the agent can replace with a link, and
  // resolving both sides would then take the link's target as the boundary and
  // agree with itself — another agent's workspace reading as "contained". The
  // anchor has to be the workspace: that is the bind mount, which the agent
  // cannot swap from inside the container.
  if (!isRealPathWithinDir(agentRegistry.get(agentSlug).files.workspacePath(), artifactsDir)) return null
  const resolved = path.resolve(artifactsDir, artifactSlug, ...segments)
  return isRealPathWithinDir(artifactsDir, resolved) ? resolved : null
}

export function widgetSnapshotPngPath(
  agentSlug: string,
  artifactSlug: string,
  size: WidgetSize,
  scheme: WidgetScheme,
  scale: WidgetScale,
): string | null {
  return resolveWidgetPath(agentSlug, artifactSlug, SNAPSHOTS_DIRNAME, snapshotFileName(size, scheme, scale))
}

export async function readWidgetSnapshot(agentSlug: string, artifactSlug: string): Promise<WidgetSnapshot | null> {
  const metaPath = resolveWidgetPath(agentSlug, artifactSlug, SNAPSHOTS_DIRNAME, SNAPSHOT_META_FILENAME)
  if (!metaPath) return null
  try {
    return widgetSnapshotSchema.parse(JSON.parse(await fs.promises.readFile(metaPath, 'utf-8')))
  } catch {
    return null
  }
}

/**
 * Describe one artifact's widget from a manifest the caller has already read.
 * Null when the artifact does not expose a widget.
 *
 * The artifact lister reads every package.json anyway, so the agents-list path
 * hands its copy straight here rather than paying for a second scan — see
 * listArtifactsAndWidgets in artifact-service.
 */
export async function describeWidgetFromManifest(
  agentSlug: string,
  artifactSlug: string,
  manifestJson: unknown,
  now: number = Date.now(),
): Promise<ApiAgentWidget | null> {
  // The manifest decides whether there is a widget here at all, and answering
  // that costs no disk. Resolving the path first made every dashboard-only
  // artifact pay for a containment check it was about to throw away.
  let pkg
  let shape
  try {
    shape = artifactShapeOf(manifestJson)
    if (!shape.widget) return null
    pkg = artifactPackageSchema.parse(manifestJson)
  } catch {
    return null
  }
  const dir = resolveWidgetPath(agentSlug, artifactSlug)
  if (!dir) return null

  // Scripted or static is a manifest fact (`scripts.widget`, run as
  // `bun run widget` in the container), so answering it costs no disk reads.
  const hasScript = typeof pkg.scripts?.widget === 'string' && pkg.scripts.widget.trim().length > 0
  const [html, snapshot] = await Promise.all([
    fs.promises.readFile(path.join(dir, WIDGET_HTML_FILENAME)).catch(() => null),
    readWidgetSnapshot(agentSlug, artifactSlug),
  ])
  const htmlHash = html ? hashWidgetHtml(html) : null
  const state = { hasHtml: html !== null, hasScript, htmlHash }
  return {
    slug: artifactSlug,
    name: pkg.name || artifactSlug,
    description: pkg.description || '',
    size: shape.widget.size ?? 'small',
    hasDashboard: shape.isDashboard,
    ...state,
    refreshOnTurnEnd: shape.widget.refreshOnTurnEnd === true,
    generatedAt: snapshot?.generatedAt ?? null,
    validUntil: snapshot?.validUntil ?? null,
    lastError: snapshot?.lastError ?? null,
    isStale: isWidgetStale(state, snapshot, now),
    refreshing: false,
  }
}

/**
 * Describe one artifact's widget, reading its manifest first. For callers that
 * hold nothing but a slug (the widget routes); the listing paths read the
 * manifest once for both halves of the artifact instead.
 */
export async function readWidgetFromFilesystem(
  agentSlug: string,
  artifactSlug: string,
  now: number = Date.now(),
): Promise<ApiAgentWidget | null> {
  const dir = resolveWidgetPath(agentSlug, artifactSlug)
  if (!dir) return null
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(await fs.promises.readFile(path.join(dir, 'package.json'), 'utf-8'))
  } catch {
    return null
  }
  return describeWidgetFromManifest(agentSlug, artifactSlug, manifestJson, now)
}

/**
 * List an agent's widgets from the host filesystem. Works whether or not the
 * container is running — snapshots persist in the bind-mounted workspace, so
 * a widget shows exactly what it showed last time, across app launches.
 *
 * The refresh service's own triggers use this; the agents-list path goes
 * through listArtifactsAndWidgets, which shares one scan with the dashboards.
 */
export async function listWidgetsFromFilesystem(agentSlug: string): Promise<ApiAgentWidget[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(artifactsDirFor(agentSlug), { withFileTypes: true })
  } catch {
    return []
  }
  // Test doubles of fs resolve readdir with nothing; treat that as no artifacts.
  if (!Array.isArray(entries)) return []
  const limit = pLimit(8)
  const now = Date.now()
  const widgets = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isWidgetSlug(entry.name))
      .map((entry) => limit(() => readWidgetFromFilesystem(agentSlug, entry.name, now))),
  )
  return widgets.filter((w): w is ApiAgentWidget => w !== null)
}

/** A directory name that can appear in a widget route's path. */
export function isWidgetSlug(name: string): boolean {
  return WIDGET_SLUG_REGEX.test(name)
}

/**
 * Tail of the widget's refresh log, for pasting into a repair session. The
 * container appends to this file on every refresh.
 */
export async function readWidgetLogTail(
  agentSlug: string,
  artifactSlug: string,
  maxChars = 2000,
): Promise<string | null> {
  const logPath = resolveWidgetPath(agentSlug, artifactSlug, WIDGET_LOG_FILENAME)
  if (!logPath) return null
  try {
    const content = await fs.promises.readFile(logPath, 'utf-8')
    const trimmed = content.trimEnd()
    if (!trimmed) return null
    return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed
  } catch {
    return null
  }
}

export async function readWidgetHtml(agentSlug: string, artifactSlug: string): Promise<string | null> {
  const htmlPath = resolveWidgetPath(agentSlug, artifactSlug, WIDGET_HTML_FILENAME)
  if (!htmlPath) return null
  try {
    return await fs.promises.readFile(htmlPath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * CSP for the in-app iframe. Widgets are display-only: no scripts, no
 * network, inline styles and data: images only. Paired with a sandbox
 * attribute WITHOUT allow-scripts on the renderer side.
 */
export const WIDGET_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'"

/**
 * The same policy carried inside the document, for the copy the app inlines
 * into an iframe with `srcdoc`.
 *
 * The app cannot frame the URL directly: the renderer is `file://` in a
 * packaged desktop build and a different port in `dev:electron`, so
 * `frame-ancestors 'self'` — which is doing its job, keeping other sites out —
 * blocks our own frame everywhere except the web build, where renderer and API
 * happen to share an origin. Inlining the document sidesteps the origin
 * question entirely, and this meta keeps the restrictions with it.
 * `frame-ancestors` is dropped because it is ignored in a meta tag; the
 * response header still carries it for anyone fetching the URL.
 */
const WIDGET_DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${WIDGET_DOCUMENT_CSP}">`

/**
 * The snapshot as the app should render it: scheme stamped, policy inlined.
 */
export function renderWidgetDocument(html: string, scheme: WidgetScheme): string {
  // Parse the platform head before any authored markup. Searching for a head
  // tag can put the policy inside a comment, attribute, or raw-text element.
  // Keep the head open so authored metadata and styles stay in it. The HTML
  // parser merges later html attributes without replacing our data-theme,
  // and an authored CSP can only add restrictions to this first policy.
  return `<!DOCTYPE html><html data-theme="${scheme}"><head>${CSP_META}${html}`
}
