import { agentRegistry, joinWorkspacePath } from '@shared/lib/agent-actor'
import {
  WIDGET_HTML_FILENAME,
  snapshotFileName,
  type ApiAgentWidget,
  type WidgetScale,
  type WidgetScheme,
  type WidgetSize,
  type WidgetSnapshot,
} from '@shared/lib/widgets/widget-schema'
import {
  ARTIFACT_MANIFEST_FILENAME,
  SNAPSHOTS_DIRNAME,
  containedPathIn,
  describeWidgetIn,
  readDocIn,
  readTextIn,
  readWidgetSnapshotIn,
  scanArtifactsIn,
  widgetPath,
} from './artifact-scan'

const WIDGET_LOG_FILENAME = 'widget.log'

export function widgetSnapshotPngPath(
  artifactSlug: string,
  size: WidgetSize,
  scheme: WidgetScheme,
  scale: WidgetScale,
): string | null {
  return widgetPath(artifactSlug, SNAPSHOTS_DIRNAME, snapshotFileName(size, scheme, scale))
}

/**
 * Where an artifact path really is, or null when nothing is there or it leads
 * out of the workspace. The artifact dir lives in the workspace the agent's
 * container bind-mounts, so the agent can plant a link there: a string-only
 * check passes `widget.html -> /etc/passwd` and the host serves whatever it
 * points at, under the caller's permission to read their own agent. This is
 * the check the widget reads always made, anchored on the workspace (which
 * the agent cannot swap from inside the container, so a swapped `artifacts`
 * is caught too), now asked of the actor. The dashboard listing and the
 * dashboard screenshot read as named, as they always did; extending the
 * check to them is part of the containment work tracked separately.
 */
export function containedArtifactPath(agentSlug: string, workspacePath: string | null): Promise<string | null> {
  return containedPathIn(agentRegistry.get(agentSlug).files, workspacePath)
}

/**
 * A whole file from the agent's workspace, or null when there is none. A path
 * that leads out of the workspace, or a directory where a file should be,
 * reads as absent too, as it always has on these read paths.
 */
export function readArtifactDoc(agentSlug: string, workspacePath: string | null): Promise<Uint8Array | null> {
  return readDocIn(agentRegistry.get(agentSlug).files, workspacePath)
}

export function readWidgetSnapshot(agentSlug: string, artifactSlug: string): Promise<WidgetSnapshot | null> {
  return readWidgetSnapshotIn(agentRegistry.get(agentSlug).files, artifactSlug)
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
  const dir = widgetPath(artifactSlug)
  if (!dir) return null
  const files = agentRegistry.get(agentSlug).files
  const manifest = await readTextIn(files, joinWorkspacePath(dir, ARTIFACT_MANIFEST_FILENAME))
  if (manifest === null) return null
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(manifest)
  } catch {
    return null
  }
  return describeWidgetIn(files, artifactSlug, manifestJson, now)
}

/**
 * List an agent's widgets from its workspace. Works whether or not the
 * container is running — snapshots persist in the bind-mounted workspace, so
 * a widget shows exactly what it showed last time, across app launches.
 *
 * The refresh service's own triggers use this. It is the scan the agents list
 * makes (`scanArtifactsIn`), so the two never disagree about which widgets exist.
 */
export async function listWidgetsFromFilesystem(agentSlug: string): Promise<ApiAgentWidget[]> {
  return (await scanArtifactsIn(agentRegistry.get(agentSlug).files, { includeWidgets: true, agentSlug })).widgets
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
  const content = await readTextIn(agentRegistry.get(agentSlug).files, widgetPath(artifactSlug, WIDGET_LOG_FILENAME))
  if (content === null) return null
  const trimmed = content.trimEnd()
  if (!trimmed) return null
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed
}

export async function readWidgetHtml(agentSlug: string, artifactSlug: string): Promise<string | null> {
  return readTextIn(agentRegistry.get(agentSlug).files, widgetPath(artifactSlug, WIDGET_HTML_FILENAME))
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
