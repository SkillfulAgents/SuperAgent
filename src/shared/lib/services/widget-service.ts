import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import pLimit from 'p-limit'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
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
  return path.join(getAgentWorkspaceDir(agentSlug), 'artifacts')
}

/**
 * Absolute path of a file inside an artifact dir, or null when the slug or
 * file would escape <workspace>/artifacts. Every route that touches disk
 * goes through here.
 */
export function resolveWidgetPath(agentSlug: string, artifactSlug: string, ...segments: string[]): string | null {
  if (!WIDGET_SLUG_REGEX.test(artifactSlug)) return null
  const artifactsDir = artifactsDirFor(agentSlug)
  const resolved = path.resolve(artifactsDir, artifactSlug, ...segments)
  return isPathWithinDir(artifactsDir, resolved) ? resolved : null
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
  const dir = resolveWidgetPath(agentSlug, artifactSlug)
  if (!dir) return null
  let pkg
  let shape
  try {
    shape = artifactShapeOf(manifestJson)
    if (!shape.widget) return null
    pkg = artifactPackageSchema.parse(manifestJson)
  } catch {
    return null
  }

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
 * Force the colour scheme the app is showing onto the snapshot document. The
 * widget guidelines have authors style `:root[data-theme="dark"]`, so
 * stamping the attribute on <html> is enough.
 */
export function applyWidgetScheme(html: string, scheme: WidgetScheme): string {
  const stamped = html.replace(/<html(\s[^>]*)?>/i, (match, attrs: string | undefined) => {
    const rest = (attrs ?? '').replace(/\sdata-theme="[^"]*"/i, '')
    return `<html data-theme="${scheme}"${rest}>`
  })
  return stamped === html ? `<html data-theme="${scheme}">${html}</html>` : stamped
}

/**
 * CSP for the in-app iframe. Widgets are display-only: no scripts, no
 * network, inline styles and data: images only. Paired with a sandbox
 * attribute WITHOUT allow-scripts on the renderer side.
 */
export const WIDGET_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'"
