import { createHash } from 'crypto'
import pLimit from 'p-limit'
import { WorkspaceFileError, agentRegistry, joinWorkspacePath, type FileEntry } from '@shared/lib/agent-actor'
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
const ARTIFACTS_DIRNAME = 'artifacts'
const ARTIFACT_MANIFEST_FILENAME = 'package.json'
const SNAPSHOTS_DIRNAME = 'snapshots'
const SNAPSHOT_META_FILENAME = 'snapshot.json'
const WIDGET_LOG_FILENAME = 'widget.log'

/** Same 16-hex-char sha256 prefix the container writes into snapshot.json. */
export function hashWidgetHtml(html: string | Uint8Array): string {
  return createHash('sha256').update(html).digest('hex').slice(0, 16)
}

/**
 * True for an artifact that exposes only a widget (no start script). The
 * dashboard lister skips these — the two kinds share artifacts/.
 */
export function isWidgetOnlyArtifact(pkg: unknown): boolean {
  return !artifactShapeOf(pkg).isDashboard
}

/**
 * Workspace path of the directory that holds an agent's artifacts. A
 * workspace path is relative to that agent's workspace root, so it is the
 * same spelling for every agent; the slug stays in the signature because the
 * path only means something next to `agentRegistry.get(agentSlug).files`.
 */
export function artifactsDirFor(_agentSlug: string): string {
  return ARTIFACTS_DIRNAME
}

/** One path segment: a directory or file name, not a climb and not a path. */
function isPlainSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && !/[/\\\0]/.test(segment)
}

/**
 * Workspace path of a file inside an artifact dir, or null when the slug is
 * not an artifact slug or a segment would leave the artifact's directory.
 * Every route that touches an artifact's files goes through here.
 *
 * This is domain validation only: a slug like `../x` is a bad slug and is
 * answered as one. Containment — lexical and through links the agent can plant
 * in its bind-mounted workspace — is the actor's job. The path returned here
 * is handed to `agentRegistry.get(agentSlug).files`, which refuses anything
 * that leaves the workspace, and nothing here knows where that workspace is.
 */
export function resolveWidgetPath(agentSlug: string, artifactSlug: string, ...segments: string[]): string | null {
  if (!WIDGET_SLUG_REGEX.test(artifactSlug)) return null
  if (!segments.every(isPlainSegment)) return null
  return joinWorkspacePath(artifactsDirFor(agentSlug), artifactSlug, ...segments)
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

/**
 * A whole file from the agent's workspace, or null when there is none. A path
 * the actor refuses (a link out of the workspace, a directory where a file
 * should be) reads as absent too, as it always has on these read paths.
 */
async function readArtifactDoc(agentSlug: string, workspacePath: string | null): Promise<Uint8Array | null> {
  if (workspacePath === null) return null
  try {
    return await agentRegistry.get(agentSlug).files.getDoc(workspacePath)
  } catch {
    return null
  }
}

async function readArtifactText(agentSlug: string, workspacePath: string | null): Promise<string | null> {
  const bytes = await readArtifactDoc(agentSlug, workspacePath)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

/**
 * True when a listing failed for a reason that means "nothing to list": no
 * directory there yet, a file where the directory should be, or a directory
 * the actor refuses to follow (a link planted out of the workspace). The
 * agents list fans out over every agent's artifacts, so a planted link must
 * read as an empty listing rather than take the whole list down — and there is
 * nothing trustworthy to show for it anyway.
 */
export function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof WorkspaceFileError
}

export async function readWidgetSnapshot(agentSlug: string, artifactSlug: string): Promise<WidgetSnapshot | null> {
  const meta = await readArtifactText(
    agentSlug,
    resolveWidgetPath(agentSlug, artifactSlug, SNAPSHOTS_DIRNAME, SNAPSHOT_META_FILENAME),
  )
  if (meta === null) return null
  try {
    return widgetSnapshotSchema.parse(JSON.parse(meta))
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
  // that costs no reads. Every dashboard-only artifact stops here.
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
  // `bun run widget` in the container), so answering it costs no reads.
  const hasScript = typeof pkg.scripts?.widget === 'string' && pkg.scripts.widget.trim().length > 0
  const [html, snapshot] = await Promise.all([
    readArtifactDoc(agentSlug, joinWorkspacePath(dir, WIDGET_HTML_FILENAME)),
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
  const manifest = await readArtifactText(agentSlug, joinWorkspacePath(dir, ARTIFACT_MANIFEST_FILENAME))
  if (manifest === null) return null
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(manifest)
  } catch {
    return null
  }
  return describeWidgetFromManifest(agentSlug, artifactSlug, manifestJson, now)
}

/**
 * List an agent's widgets from its workspace. Works whether or not the
 * container is running — snapshots persist in the bind-mounted workspace, so
 * a widget shows exactly what it showed last time, across app launches.
 *
 * The refresh service's own triggers use this; the agents-list path goes
 * through listArtifactsAndWidgets, which shares one scan with the dashboards.
 */
export async function listWidgetsFromFilesystem(agentSlug: string): Promise<ApiAgentWidget[]> {
  let entries: FileEntry[]
  try {
    entries = await agentRegistry.get(agentSlug).files.list(artifactsDirFor(agentSlug))
  } catch (error) {
    // No artifacts directory yet: nothing to list.
    if (isMissingDirectoryError(error)) return []
    throw error
  }
  const limit = pLimit(8)
  const now = Date.now()
  const widgets = await Promise.all(
    entries
      .filter((entry) => entry.kind === 'directory' && isWidgetSlug(entry.name))
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
  const content = await readArtifactText(agentSlug, resolveWidgetPath(agentSlug, artifactSlug, WIDGET_LOG_FILENAME))
  if (content === null) return null
  const trimmed = content.trimEnd()
  if (!trimmed) return null
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed
}

export async function readWidgetHtml(agentSlug: string, artifactSlug: string): Promise<string | null> {
  return readArtifactText(agentSlug, resolveWidgetPath(agentSlug, artifactSlug, WIDGET_HTML_FILENAME))
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
