import { spawn } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { ARTIFACTS_DIR, validateSlug, truncateOversizedLog, BUN_INSTALL_NETWORK_CONCURRENCY } from './dashboard-manager'
import { readArtifactShapeSync, type ArtifactShape } from './artifact-kind'
import { notifyWidgetSnapshotReady } from './host-events'
import { rasterizeWidget } from './widget-rasterizer'
import {
  ArtifactPackageSchema,
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
  FALLBACK_VALIDITY_SECONDS,
  MAX_SCRIPT_TIMEOUT_SECONDS,
  WIDGET_HTML_FILENAME,
  WIDGET_META_FILENAME,
  WidgetMetaSchema,
  WidgetSnapshotSchema,
  type WidgetConfig,
  type WidgetInfo,
  type WidgetSize,
  type WidgetSnapshot,
} from './widget-schema'

export const WIDGET_LOG_FILENAME = 'widget.log'
export const SNAPSHOTS_DIRNAME = 'snapshots'
export const SNAPSHOT_META_FILENAME = 'snapshot.json'

// A failed refresh is retried on the next stale check rather than every
// page load: a broken script must not be re-run each time Agent Home opens.
const FAILED_REFRESH_RETRY_SECONDS = 5 * 60

/**
 * The manifest script that regenerates a widget, run exactly like a
 * dashboard's `start`: `bun run <name>` in the artifact directory, with bun
 * resolving the command from package.json.
 */
export const WIDGET_SCRIPT_NAME = 'widget'
export const WIDGET_RUN_COMMAND = ['bun', 'run', WIDGET_SCRIPT_NAME]

/** What `create_widget` writes into scripts.widget. */
export const DEFAULT_WIDGET_SCRIPT_COMMAND = 'bun run widget.ts'

export function hashHtml(html: string | Buffer): string {
  return createHash('sha256').update(html).digest('hex').slice(0, 16)
}

interface ScriptRunResult {
  ok: boolean
  error: string | null
}

interface WidgetManifest {
  name: string
  description: string
  size: WidgetSize
  /** The scripts.widget command, or null for a static widget. */
  script: string | null
  timeoutSeconds: number
  refreshOnTurnEnd: boolean
  hasDependencies: boolean
  shape: ArtifactShape
}

class WidgetManager {
  // Refreshes run one at a time: each rasterization launches a Chromium and
  // the container has few CPUs. Concurrent requests for the SAME widget share
  // one run instead of queueing a redundant second one.
  private queue: Promise<unknown> = Promise.resolve()
  private inflight = new Map<string, Promise<WidgetSnapshot>>()

  private artifactDir(slug: string): string {
    validateSlug(slug)
    return path.join(ARTIFACTS_DIR, slug)
  }

  /** Manifest of an artifact that exposes a widget; null otherwise. */
  private readManifest(slug: string): WidgetManifest | null {
    const dir = this.artifactDir(slug)
    const shape = readArtifactShapeSync(dir)
    if (!shape?.widget) return null
    try {
      const pkg = ArtifactPackageSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')))
      const config: WidgetConfig = shape.widget
      return {
        name: pkg.name || slug,
        description: pkg.description || '',
        size: config.size ?? 'small',
        script: pkg.scripts?.widget?.trim() || null,
        // The cap is applied here rather than in the schema: a manifest asking
        // for 300s should run with 120, not lose its widget block.
        timeoutSeconds: Math.min(config.timeoutSeconds ?? DEFAULT_SCRIPT_TIMEOUT_SECONDS, MAX_SCRIPT_TIMEOUT_SECONDS),
        refreshOnTurnEnd: config.refreshOnTurnEnd === true,
        hasDependencies: Object.keys(pkg.dependencies ?? {}).length > 0,
        shape,
      }
    } catch {
      return null
    }
  }

  readSnapshot(slug: string): WidgetSnapshot | null {
    try {
      const raw = fs.readFileSync(
        path.join(this.artifactDir(slug), SNAPSHOTS_DIRNAME, SNAPSHOT_META_FILENAME),
        'utf-8',
      )
      return WidgetSnapshotSchema.parse(JSON.parse(raw))
    } catch {
      return null
    }
  }

  getWidget(slug: string): WidgetInfo | null {
    const manifest = this.readManifest(slug)
    if (!manifest) return null
    return {
      slug,
      name: manifest.name,
      description: manifest.description,
      size: manifest.size,
      hasDashboard: manifest.shape.isDashboard,
      hasScript: manifest.script !== null,
      hasHtml: fs.existsSync(path.join(this.artifactDir(slug), WIDGET_HTML_FILENAME)),
      refreshOnTurnEnd: manifest.refreshOnTurnEnd,
      snapshot: this.readSnapshot(slug),
    }
  }

  listWidgets(): WidgetInfo[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true })
    } catch {
      return []
    }
    const result: WidgetInfo[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const info = this.getWidget(entry.name)
        if (info) result.push(info)
      } catch {
        // Invalid slug — not ours.
      }
    }
    return result
  }

  /**
   * Run the widget's refresh script (if any), rasterize widget.html, and
   * write snapshot.json. Serialized across widgets; deduplicated per widget.
   * Resolves with the new snapshot even when the script failed — the failure
   * is recorded in `lastError` and the previous widget.html keeps serving.
   */
  refreshWidget(slug: string): Promise<WidgetSnapshot> {
    let dir: string
    try {
      dir = this.artifactDir(slug)
    } catch (error) {
      return Promise.reject(error)
    }
    const existing = this.inflight.get(slug)
    if (existing) return existing

    const run = this.queue.then(() => this.doRefresh(slug, dir))
    // Keep the chain alive past failures so one bad refresh can't stall the rest.
    this.queue = run.catch(() => {})
    this.inflight.set(slug, run)
    run.finally(() => {
      if (this.inflight.get(slug) === run) this.inflight.delete(slug)
    }).catch(() => {})
    return run
  }

  private async doRefresh(slug: string, dir: string): Promise<WidgetSnapshot> {
    const manifest = this.readManifest(slug)
    if (!manifest) {
      throw new Error(`/workspace/artifacts/${slug} does not expose a widget (no gamut.widget in package.json)`)
    }
    const startedAt = Date.now()
    const logPath = path.join(dir, WIDGET_LOG_FILENAME)
    await truncateOversizedLog(logPath)
    const log = fs.createWriteStream(logPath, { flags: 'a' })
    log.on('error', (error) => {
      console.error(`[WidgetManager] Log stream error for ${slug}:`, error)
    })
    log.write(`\n[WidgetManager] refresh started ${new Date(startedAt).toISOString()}\n`)

    let error: string | null = null
    let scriptRan = false
    const htmlPath = path.join(dir, WIDGET_HTML_FILENAME)
    const metaPath = path.join(dir, WIDGET_META_FILENAME)
    try {
      if (manifest.script) {
        scriptRan = true
        // The script may import the artifact's own dependencies (a dashboard's
        // data helpers); a widget-only artifact that declares deps has never
        // had them installed by a dashboard start.
        if (manifest.hasDependencies && !fs.existsSync(path.join(dir, 'node_modules'))) {
          const install = await this.runProcess(dir, slug, ['bun', 'install', `--network-concurrency=${BUN_INSTALL_NETWORK_CONCURRENCY}`], 120, log)
          if (!install.ok) error = `bun install failed before the refresh script: ${install.error}`
        }
        if (!error) {
          // The script's sidecar is what tells us how long its output stays
          // true; a stale one from a previous run must not be mistaken for it.
          await fs.promises.rm(metaPath, { force: true })
          const result = await this.runProcess(dir, slug, WIDGET_RUN_COMMAND, manifest.timeoutSeconds, log)
          if (!result.ok) error = result.error
        }
      }

      let htmlHash = ''
      let renderedSizes: string[] = []
      if (!fs.existsSync(htmlPath)) {
        error ??= `${WIDGET_HTML_FILENAME} is missing — the refresh script must write it`
      } else {
        htmlHash = hashHtml(await fs.promises.readFile(htmlPath))
        const raster = await rasterizeWidget(dir)
        renderedSizes = raster.rendered
        if (raster.error) {
          log.write(`[WidgetManager] rasterize: ${raster.error}\n`)
          // A missing Chromium only costs the PNG snapshots; the HTML
          // snapshot still serves every in-app surface, so this is not a
          // refresh failure.
          if (renderedSizes.length === 0 && !error) {
            console.warn(`[WidgetManager] No PNG snapshots for ${slug}: ${raster.error}`)
          }
        }
      }

      const generatedAt = new Date()
      const validity = this.resolveValidity(metaPath, generatedAt, { scriptRan, error, log })
      const snapshot = WidgetSnapshotSchema.parse({
        generatedAt: generatedAt.toISOString(),
        validUntil: validity.validUntil,
        validityDefaulted: validity.defaulted,
        htmlHash,
        renderedSizes,
        scriptRan,
        durationMs: Date.now() - startedAt,
        lastError: error,
      })
      await this.writeSnapshot(dir, snapshot)
      log.write(
        `[WidgetManager] refresh ${error ? 'FAILED' : 'ok'} in ${snapshot.durationMs}ms` +
          `${error ? `: ${error}` : ''}${snapshot.validUntil ? ` (valid until ${snapshot.validUntil})` : ''}\n`,
      )
      void notifyWidgetSnapshotReady(slug, snapshot).catch((err) => {
        console.warn(`[WidgetManager] Failed to publish snapshot event for ${slug}:`, err)
      })
      return snapshot
    } finally {
      log.end()
    }
  }

  /**
   * validUntil for a new snapshot:
   * - failed run → short retry window, so a broken script is not re-run on
   *   every page load but is retried without waiting a whole cycle
   * - script wrote widget.json → the script's own verdict (null = never)
   * - script wrote nothing → platform fallback, flagged so the tool can
   *   nudge the agent to compute a real one
   * - no script at all → never expires on its own (only a rewrite changes it)
   */
  private resolveValidity(
    metaPath: string,
    generatedAt: Date,
    ctx: { scriptRan: boolean; error: string | null; log: fs.WriteStream },
  ): { validUntil: string | null; defaulted: boolean } {
    const at = (seconds: number) => new Date(generatedAt.getTime() + seconds * 1000).toISOString()
    if (ctx.error) return { validUntil: at(FAILED_REFRESH_RETRY_SECONDS), defaulted: true }
    if (!ctx.scriptRan) return { validUntil: null, defaulted: false }
    try {
      const meta = WidgetMetaSchema.parse(JSON.parse(fs.readFileSync(metaPath, 'utf-8')))
      if (meta.validUntil !== null && Date.parse(meta.validUntil) <= generatedAt.getTime()) {
        ctx.log.write(`[WidgetManager] ${WIDGET_META_FILENAME} validUntil is already in the past; using the fallback window\n`)
        return { validUntil: at(FALLBACK_VALIDITY_SECONDS), defaulted: true }
      }
      return { validUntil: meta.validUntil, defaulted: false }
    } catch (err: unknown) {
      const reason = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? 'not written by the script'
        : `invalid: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
      ctx.log.write(`[WidgetManager] ${WIDGET_META_FILENAME} ${reason}; using the ${FALLBACK_VALIDITY_SECONDS}s fallback window\n`)
      return { validUntil: at(FALLBACK_VALIDITY_SECONDS), defaulted: true }
    }
  }

  private async writeSnapshot(dir: string, snapshot: WidgetSnapshot): Promise<void> {
    const outDir = path.join(dir, SNAPSHOTS_DIRNAME)
    await fs.promises.mkdir(outDir, { recursive: true })
    const finalPath = path.join(outDir, SNAPSHOT_META_FILENAME)
    const tmpPath = `${finalPath}.tmp`
    await fs.promises.writeFile(tmpPath, JSON.stringify(snapshot, null, 2) + '\n')
    await fs.promises.rename(tmpPath, finalPath)
  }

  private runProcess(
    dir: string,
    slug: string,
    command: string[],
    timeoutSeconds: number,
    log: fs.WriteStream,
  ): Promise<ScriptRunResult> {
    return new Promise<ScriptRunResult>((resolve) => {
      const [bin, ...args] = command
      log.write(`[WidgetManager] running: ${command.join(' ')} (timeout ${timeoutSeconds}s)\n`)
      const proc = spawn(bin, args, {
        cwd: dir,
        env: {
          ...process.env,
          WIDGET_SLUG: slug,
          WIDGET_DIR: dir,
          WIDGET_OUTPUT: path.join(dir, WIDGET_HTML_FILENAME),
          WIDGET_META: path.join(dir, WIDGET_META_FILENAME),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderrTail = ''
      let settled = false
      const finish = (result: ScriptRunResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        log.write(`[WidgetManager] ${bin} exceeded ${timeoutSeconds}s, killing\n`)
        proc.kill('SIGKILL')
        finish({ ok: false, error: `Refresh script exceeded ${timeoutSeconds}s` })
      }, timeoutSeconds * 1000)

      proc.stdout?.on('data', (chunk: Buffer) => log.write(chunk))
      proc.stderr?.on('data', (chunk: Buffer) => {
        log.write(chunk)
        stderrTail = (stderrTail + chunk.toString()).slice(-2000)
      })
      proc.on('error', (err) => {
        log.write(`[WidgetManager] spawn error: ${err.message}\n`)
        finish({ ok: false, error: `Could not run ${bin}: ${err.message}` })
      })
      proc.on('exit', (code, signal) => {
        if (code === 0) {
          finish({ ok: true, error: null })
        } else {
          const reason = signal ? `signal ${signal}` : `exit code ${code}`
          const detail = stderrTail.trim()
          finish({
            ok: false,
            error: `Refresh script failed (${reason})${detail ? `: ${detail.split('\n').slice(-5).join('\n')}` : ''}`,
          })
        }
      })
    })
  }

  async getWidgetLogs(slug: string, clear = false): Promise<string> {
    const logPath = path.join(this.artifactDir(slug), WIDGET_LOG_FILENAME)
    try {
      const content = await fs.promises.readFile(logPath, 'utf-8')
      if (clear) await fs.promises.writeFile(logPath, '')
      return content
    } catch (error: any) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }

  /**
   * Give an artifact a widget. If the artifact already exists (a dashboard),
   * the widget block and files are added to it; otherwise a widget-only
   * artifact is scaffolded. `withScript` decides whether widget.ts is
   * copied — a widget the agent rewrites itself on each run has no script
   * and never goes stale.
   *
   * A widget.html or widget.ts already in the directory is left exactly as it
   * is and reported in `kept`: the guard above reads the manifest, so anything
   * that makes a manifest read as "no widget" would otherwise land here and
   * overwrite hand-written files with the template.
   */
  async createWidget(
    slug: string,
    name: string,
    description: string,
    opts: { size?: WidgetSize; withScript?: boolean; refreshOnTurnEnd?: boolean } = {},
  ): Promise<{ dir: string; addedToDashboard: boolean; kept: string[] }> {
    const dir = this.artifactDir(slug)
    const pkgPath = path.join(dir, 'package.json')
    const templateDir = path.join(
      process.env.HOME || '/home/claude',
      '.claude/skills/widgets/templates/basic',
    )
    const widgetBlock: WidgetConfig = {
      size: opts.size ?? 'small',
      timeoutSeconds: DEFAULT_SCRIPT_TIMEOUT_SECONDS,
      ...(opts.refreshOnTurnEnd ? { refreshOnTurnEnd: true } : {}),
    }

    let existing: Record<string, unknown> | null = null
    try {
      existing = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'))
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
    if (existing && readArtifactShapeSync(dir)?.widget) {
      throw new Error(`"${slug}" already exposes a widget. Edit its widget.ts / widget.html, or pick another slug.`)
    }

    const withScript = opts.withScript ?? true
    await fs.promises.mkdir(dir, { recursive: true })
    const kept: string[] = []
    await copyTemplateFile(templateDir, dir, WIDGET_HTML_FILENAME, kept)
    if (withScript) await copyTemplateFile(templateDir, dir, 'widget.ts', kept)
    // The widget command joins the artifact's existing scripts (a dashboard's
    // `start` keeps working); the gamut block stays the marker + config.
    const scripts = {
      ...((existing?.scripts as Record<string, unknown> | undefined) ?? {}),
      ...(withScript ? { [WIDGET_SCRIPT_NAME]: DEFAULT_WIDGET_SCRIPT_COMMAND } : {}),
    }
    const pkg = existing
      ? {
          ...existing,
          ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
          gamut: { ...((existing.gamut as Record<string, unknown> | undefined) ?? {}), widget: widgetBlock },
        }
      : {
          name,
          description,
          ...(withScript ? { scripts } : {}),
          gamut: { widget: widgetBlock },
        }
    ArtifactPackageSchema.parse(pkg)
    await fs.promises.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    return { dir, addedToDashboard: existing !== null, kept }
  }
}

/**
 * Copy one template file, never over an existing one. COPYFILE_EXCL rather
 * than an existsSync check: the decision and the write are the same syscall,
 * so there is no window between them.
 */
async function copyTemplateFile(
  templateDir: string,
  dir: string,
  fileName: string,
  kept: string[],
): Promise<void> {
  try {
    await fs.promises.copyFile(
      path.join(templateDir, fileName),
      path.join(dir, fileName),
      fs.constants.COPYFILE_EXCL,
    )
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
    kept.push(fileName)
  }
}

export const widgetManager = new WidgetManager()
