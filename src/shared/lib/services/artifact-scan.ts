/**
 * An agent's artifacts (dashboards and widgets), read from the files it is
 * given: the agent's actor passes its own, and a store of the agent's saved
 * files can pass those. It imports no registry, so a process that only has
 * the files (an agent object answering for a sleeping agent) loads no more
 * than this to answer.
 */
import { createHash } from 'crypto'
import pLimit from 'p-limit'
import type { FileEntry, FileOps } from '@shared/lib/agent-actor/types'
import { WorkspaceFileError, joinWorkspacePath } from '@shared/lib/agent-actor/workspace-path'
import {
  WIDGET_HTML_FILENAME,
  artifactPackageSchema,
  artifactShapeOf,
  isWidgetStale,
  widgetSnapshotSchema,
  type ApiAgentWidget,
  type WidgetSnapshot,
} from '@shared/lib/widgets/widget-schema'

/** The reads a scan makes. */
export type ArtifactFiles = Pick<FileOps, 'list' | 'stat' | 'resolve' | 'getDoc'>

export const WIDGET_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
export const ARTIFACTS_DIRNAME = 'artifacts'
export const ARTIFACT_MANIFEST_FILENAME = 'package.json'
export const SNAPSHOTS_DIRNAME = 'snapshots'
const SNAPSHOT_META_FILENAME = 'snapshot.json'
const ARTIFACT_SCREENSHOT_FILENAME = 'screenshot.png'

export interface ArtifactInfo {
  slug: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  port: number
  hasScreenshot?: boolean
  startupPhase?: 'installing-dependencies' | 'starting-server'
  firstRun?: boolean
}

/** Both halves of an agent's artifacts, from one scan. */
export interface ArtifactListing {
  dashboards: ArtifactInfo[]
  widgets: ApiAgentWidget[]
}

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

/** A directory name that can appear in a widget route's path. */
export function isWidgetSlug(name: string): boolean {
  return WIDGET_SLUG_REGEX.test(name)
}

/** One path segment: a directory or file name, not a climb and not a path. */
function isPlainSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && !/[/\\\0]/.test(segment)
}

/**
 * Workspace path of a file inside a widget's artifact dir, or null when the
 * slug is not a widget slug or a segment would leave the artifact's directory.
 * Every route that touches a widget's files goes through here.
 *
 * This is domain validation only: a slug like `../x` is a bad slug and is
 * answered as one. Lexical containment is the actor's, and the readers below
 * ask it where the path really is before reading it (`containedPathIn`);
 * nothing here knows where the workspace is.
 */
export function widgetPath(artifactSlug: string, ...segments: string[]): string | null {
  if (!WIDGET_SLUG_REGEX.test(artifactSlug)) return null
  if (!segments.every(isPlainSegment)) return null
  return joinWorkspacePath(ARTIFACTS_DIRNAME, artifactSlug, ...segments)
}

/**
 * The same for any artifact, not only a widget: an artifact is whatever
 * directory under artifacts/ carries a manifest, and the listing shows it
 * under the name it has, so its thumbnail, rename and delete accept that
 * name too. One plain directory name is the whole rule; the widget slug
 * rule applies only where the container's widget code made the directory.
 */
export function artifactPath(artifactSlug: string, ...segments: string[]): string | null {
  if (![artifactSlug, ...segments].every(isPlainSegment)) return null
  return joinWorkspacePath(ARTIFACTS_DIRNAME, artifactSlug, ...segments)
}

/**
 * True when a listing failed for a reason that means "nothing to list": no
 * directory there yet, a file where the directory should be, or a directory
 * the files refuse to follow (a link planted out of the workspace).
 */
export function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof WorkspaceFileError
}

/** Where a path really is, or null when nothing is there or it leads out of the workspace. */
export async function containedPathIn(files: ArtifactFiles, workspacePath: string | null): Promise<string | null> {
  if (workspacePath === null) return null
  try {
    return await files.resolve(workspacePath)
  } catch (error) {
    if (error instanceof WorkspaceFileError) return null
    throw error
  }
}

/** A whole file, or null when there is none, it leads out of the workspace, or it is a directory. */
export async function readDocIn(files: ArtifactFiles, workspacePath: string | null): Promise<Uint8Array | null> {
  const real = await containedPathIn(files, workspacePath)
  if (real === null) return null
  try {
    return await files.getDoc(real)
  } catch {
    return null
  }
}

export async function readTextIn(files: ArtifactFiles, workspacePath: string | null): Promise<string | null> {
  const bytes = await readDocIn(files, workspacePath)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

export async function readWidgetSnapshotIn(files: ArtifactFiles, artifactSlug: string): Promise<WidgetSnapshot | null> {
  const meta = await readTextIn(files, widgetPath(artifactSlug, SNAPSHOTS_DIRNAME, SNAPSHOT_META_FILENAME))
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
 */
export async function describeWidgetIn(
  files: ArtifactFiles,
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
  const dir = widgetPath(artifactSlug)
  if (!dir) return null
  // A widget's directory is checked by real location before its files are
  // read, as the widget reads always were; a link out of the workspace is no
  // widget. Dashboards are not held to this (the containment work tracked
  // separately covers them), so the check costs only widget artifacts.
  if ((await containedPathIn(files, dir)) === null) return null

  // Scripted or static is a manifest fact (`scripts.widget`, run as
  // `bun run widget` in the container), so answering it costs no reads.
  const hasScript = typeof pkg.scripts?.widget === 'string' && pkg.scripts.widget.trim().length > 0
  const [html, snapshot] = await Promise.all([
    readDocIn(files, joinWorkspacePath(dir, WIDGET_HTML_FILENAME)),
    readWidgetSnapshotIn(files, artifactSlug),
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
 * Both halves of every artifact, from a single directory scan.
 *
 * An artifact's package.json decides whether it is a dashboard, a widget or
 * both, so the agents-list path reads it ONCE and answers both questions from
 * that copy. Listing the two separately doubled the listing and the manifest
 * read of every artifact of every agent on every poll — including the warm
 * iOS poll, which is meant to be nearly free.
 */
export async function scanArtifactsIn(
  files: ArtifactFiles,
  opts: { includeWidgets: boolean; agentSlug: string },
): Promise<ArtifactListing> {
  // The directory as named, the way the plain listing read it; checking where
  // it really leads is part of the containment work tracked separately.
  let entries: FileEntry[]
  try {
    entries = await files.list(ARTIFACTS_DIRNAME)
  } catch (error) {
    // No artifacts directory yet: nothing to list. Any other failure reads the
    // same way: this runs for every agent on every agents-list poll, and one
    // agent's unreadable directory must not take the whole list down.
    if (!isMissingDirectoryError(error)) {
      console.warn(`[artifact-service] Could not list artifacts for ${opts.agentSlug}; treating as none:`, error)
    }
    return { dashboards: [], widgets: [] }
  }

  // Three independent lookups per artifact, artifacts independent of each
  // other: issue them concurrently instead of one round trip at a time —
  // this runs for every agent on every agents-list poll. The limiter bounds
  // individual probes, not artifacts: wrapping the artifact would let each
  // slot fan out to three probes, and an artifact that gives up early (no
  // package.json) would free its slot while its two siblings still ran.
  // Result order follows the directory listing, as before.
  const limit = pLimit(10)
  // One clock for the whole scan, so two widgets never disagree about staleness.
  const now = Date.now()
  const scanned = await Promise.all(
    entries
      .filter((entry) => entry.kind === 'directory')
      .map(async (entry): Promise<{ dashboard: ArtifactInfo | null; widget: ApiAgentWidget | null }> => {
        const nothing = { dashboard: null, widget: null }
        const dir = entry.path
        let pkg: { name?: unknown; description?: unknown }
        let hasScreenshot: boolean
        let hasNodeModules: boolean
        try {
          const [manifest, screenshot, nodeModules] = await Promise.all([
            limit(() => files.getDoc(joinWorkspacePath(dir, ARTIFACT_MANIFEST_FILENAME))),
            limit(() => files.stat(joinWorkspacePath(dir, ARTIFACT_SCREENSHOT_FILENAME))),
            limit(() => files.stat(joinWorkspacePath(dir, 'node_modules'))),
          ])
          if (manifest === null) return nothing
          pkg = JSON.parse(new TextDecoder().decode(manifest))
          hasScreenshot = screenshot?.kind === 'file'
          hasNodeModules = nodeModules?.kind === 'directory'
        } catch {
          // No valid package.json, skip
          return nothing
        }

        // The widget half needs its own snapshot state, but not another
        // manifest read — it is handed the copy above.
        const widget = opts.includeWidgets && isWidgetSlug(entry.name)
          ? await describeWidgetIn(files, entry.name, pkg, now)
          : null

        // A widget-only artifact has no server; it is listed as a widget only.
        if (isWidgetOnlyArtifact(pkg)) return { dashboard: null, widget }

        const info: ArtifactInfo = {
          slug: entry.name,
          name: (typeof pkg.name === 'string' && pkg.name) || entry.name,
          description: (typeof pkg.description === 'string' && pkg.description) || '',
          status: 'stopped',
          port: 0,
        }
        // Only include hasScreenshot when true — keeps the API shape minimal
        // and avoids spurious `hasScreenshot: false` fields in common responses.
        if (hasScreenshot) info.hasScreenshot = true
        // The host can report this before the agent container is running. That
        // lets the dashboard view explain first-run preparation during container
        // startup instead of flashing the state only during a fast install.
        if (!hasNodeModules) info.firstRun = true
        return { dashboard: info, widget }
      }),
  )

  return {
    dashboards: scanned.map((r) => r.dashboard).filter((info): info is ArtifactInfo => info !== null),
    widgets: scanned.map((r) => r.widget).filter((w): w is ApiAgentWidget => w !== null),
  }
}
