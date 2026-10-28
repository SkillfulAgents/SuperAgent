import * as fs from 'fs'
import * as path from 'path'
import { ArtifactPackageSchema, type WidgetConfig } from './widget-schema'

/**
 * What an artifact directory exposes, read from its package.json. Both
 * managers scan the same /workspace/artifacts; this is the one place that
 * says which of them an entry belongs to.
 *
 * - dashboard: has a `start` script — or is a legacy manifest with no
 *   widget block at all (every pre-widget artifact is a dashboard).
 * - widget: has a `gamut.widget` block.
 *
 * Null when there is no readable package.json (not an artifact).
 */
export interface ArtifactShape {
  isDashboard: boolean
  widget: WidgetConfig | null
}

export function readArtifactShapeSync(artifactDir: string): ArtifactShape | null {
  try {
    const raw = fs.readFileSync(path.join(artifactDir, 'package.json'), 'utf-8')
    return artifactShapeOf(JSON.parse(raw))
  } catch {
    return null
  }
}

export function artifactShapeOf(pkg: unknown): ArtifactShape {
  const parsed = ArtifactPackageSchema.safeParse(pkg)
  if (!parsed.success) return { isDashboard: true, widget: null }
  const widget = parsed.data.gamut?.widget ?? null
  const hasStart = typeof parsed.data.scripts?.start === 'string' && parsed.data.scripts.start.length > 0
  return { isDashboard: hasStart || widget === null, widget }
}
