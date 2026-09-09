import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const spawnHolder = vi.hoisted(() => ({
  impl: null as ((command: string, args: string[], options: unknown) => unknown) | null,
}))
const rasterMock = vi.hoisted(() => vi.fn())
const notifyMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('./widget-rasterizer', () => ({
  rasterizeWidget: (...args: unknown[]) => rasterMock(...args),
}))
vi.mock('./host-events', () => ({
  notifyWidgetSnapshotReady: (...args: unknown[]) => notifyMock(...args),
  notifyDashboardScreenshotReady: vi.fn(),
  notifyDashboardStatusChanged: vi.fn(),
}))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: string[], options: unknown) => {
      if (!spawnHolder.impl) throw new Error('spawn called before test set an impl')
      return spawnHolder.impl(command, args, options)
    },
  }
})

process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'widgets-'))
const tmpDir = process.env.ARTIFACTS_DIR

const { widgetManager, hashHtml } = await import('./widget-manager')
const { dashboardManager } = await import('./dashboard-manager')

type FakeProc = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  pid?: number
}

function fakeProcess(
  exitCode: number,
  opts: { stderr?: string; onSpawn?: () => void; neverExit?: boolean; pid?: number } = {},
): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.pid = opts.pid
  proc.kill = vi.fn(() => {
    setTimeout(() => proc.emit('exit', null, 'SIGKILL'), 0)
    return true
  })
  setTimeout(() => {
    opts.onSpawn?.()
    if (opts.stderr) proc.stderr.write(opts.stderr)
    if (!opts.neverExit) proc.emit('exit', exitCode, null)
  }, 5)
  return proc
}

function seedArtifact(
  slug: string,
  opts: {
    widget?: Record<string, unknown> | false
    start?: string
    dependencies?: Record<string, string>
    /** The scripts.widget command, e.g. 'bun run widget.ts'. */
    script?: string
    html?: string
  } = {},
): string {
  const dir = path.join(tmpDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name: `Artifact ${slug}`, description: 'test' }
  const scripts: Record<string, string> = {}
  if (opts.start) scripts.start = opts.start
  if (opts.script) scripts.widget = opts.script
  if (Object.keys(scripts).length > 0) pkg.scripts = scripts
  if (opts.dependencies) pkg.dependencies = opts.dependencies
  if (opts.widget !== false) pkg.gamut = { widget: { size: 'medium', ...(opts.widget ?? {}) } }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg))
  if (opts.html !== undefined) fs.writeFileSync(path.join(dir, 'widget.html'), opts.html)
  return dir
}

/** A script that writes widget.html (and optionally widget.json) when it "runs". */
function scriptWriting(dir: string, html: string, meta?: unknown) {
  return () =>
    fakeProcess(0, {
      onSpawn: () => {
        fs.writeFileSync(path.join(dir, 'widget.html'), html)
        if (meta !== undefined) fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify(meta))
      },
    })
}

describe('widgetManager', () => {
  beforeEach(() => {
    for (const entry of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true })
    }
    rasterMock.mockReset()
    rasterMock.mockResolvedValue({ rendered: ['small-light@2x'], error: null })
    notifyMock.mockClear()
    spawnHolder.impl = null
  })

  afterEach(() => {
    spawnHolder.impl = null
  })

  it('lists artifacts that expose a widget; dashboards list everything with a server', () => {
    seedArtifact('macros', { script: 'bun run widget.ts', html: '<html></html>' })
    seedArtifact('nutrition', { start: 'bun run serve.js', script: 'bun run widget.ts', html: '<html></html>' })
    seedArtifact('plain-dash', { widget: false, start: 'bun run index.js' })
    seedArtifact('legacy-dash', { widget: false })

    const widgets = widgetManager.listWidgets().sort((a, b) => a.slug.localeCompare(b.slug))
    expect(widgets.map((w) => [w.slug, w.hasDashboard])).toEqual([
      ['macros', false],
      ['nutrition', true],
    ])
    expect(widgets[0]).toMatchObject({
      name: 'Artifact macros',
      size: 'medium',
      hasScript: true,
      hasHtml: true,
      snapshot: null,
    })

    const dashboards = dashboardManager.listDashboards().map((d) => d.slug).sort()
    expect(dashboards).toEqual(['legacy-dash', 'nutrition', 'plain-dash'])
  })

  it('refuses to start a widget-only artifact as a dashboard', async () => {
    seedArtifact('macros', { html: '<html></html>' })
    await expect(dashboardManager.startDashboard('macros')).rejects.toThrow(/only exposes a widget/)
  })

  it('a config value the schema dislikes falls back to the default instead of erasing the widget', async () => {
    // The gamut block is what says "this artifact has a widget at all", so a
    // strict parse would turn one bad field into a vanished widget — and, for
    // a widget-only artifact, into a dashboard the container tries to start.
    seedArtifact('odd', { widget: { size: 'enormous', refreshOnTurnEnd: 'yes' }, html: '<p/>' })
    const widget = widgetManager.getWidget('odd')
    expect(widget).toMatchObject({ slug: 'odd', size: 'small', refreshOnTurnEnd: false, hasDashboard: false })
    expect(dashboardManager.listDashboards().map((d) => d.slug)).toEqual([])
  })

  it('clamps a timeout above the maximum rather than dropping the widget', async () => {
    const dir = seedArtifact('slow-but-listed', { widget: { timeoutSeconds: 600 }, script: 'bun run widget.ts', html: '<p/>' })
    expect(widgetManager.getWidget('slow-but-listed')).toMatchObject({ hasScript: true })
    spawnHolder.impl = () => scriptWriting(dir, '<p>ok</p>', { validUntil: null })()

    await expect(widgetManager.refreshWidget('slow-but-listed')).resolves.toMatchObject({ lastError: null })

    // 600 asked for, 120 granted — the cap is a clamp, not a rejection.
    expect(fs.readFileSync(path.join(dir, 'widget.log'), 'utf-8')).toContain('(timeout 120s)')
  })

  it('runs the script, takes validUntil from widget.json, rasterizes, and notifies the host', async () => {
    const dir = seedArtifact('macros', { script: 'bun run widget.ts', html: '<p>old</p>' })
    const spawned: Array<{ command: string; args: string[]; options: any }> = []
    spawnHolder.impl = (command, args, options) => {
      spawned.push({ command, args, options })
      return scriptWriting(dir, '<p>new</p>', { validUntil: '2999-01-01T09:30:00.000Z' })()
    }

    const snapshot = await widgetManager.refreshWidget('macros')

    expect(spawned).toHaveLength(1)
    // The widget half is run exactly like the dashboard half: a named
    // manifest script, resolved by bun.
    expect(spawned[0].command).toBe('bun')
    expect(spawned[0].args).toEqual(['run', 'widget'])
    expect(spawned[0].options.cwd).toBe(dir)
    expect(spawned[0].options.env.WIDGET_OUTPUT).toBe(path.join(dir, 'widget.html'))
    expect(spawned[0].options.env.WIDGET_META).toBe(path.join(dir, 'widget.json'))

    expect(snapshot).toMatchObject({
      scriptRan: true,
      lastError: null,
      validUntil: '2999-01-01T09:30:00.000Z',
      validityDefaulted: false,
      htmlHash: hashHtml('<p>new</p>'),
      renderedSizes: ['small-light@2x'],
    })
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'snapshots', 'snapshot.json'), 'utf-8'))
    expect(onDisk).toEqual(snapshot)
    expect(rasterMock).toHaveBeenCalledWith(dir)
    expect(notifyMock).toHaveBeenCalledWith('macros', snapshot)
    expect(widgetManager.getWidget('macros')?.snapshot).toEqual(snapshot)
  })

  it('runs whatever scripts.widget declares, without probing for a file', async () => {
    // Any command, not one of four extensions — and no file has to exist here
    // for the manager to consider the widget scripted.
    const dir = seedArtifact('py', { script: 'python3 -m tools.build --fast', html: '<p/>' })
    const spawned: string[][] = []
    spawnHolder.impl = (command, args) => {
      spawned.push([command, ...args])
      return scriptWriting(dir, '<p>py</p>', { validUntil: null })()
    }
    expect(widgetManager.getWidget('py')?.hasScript).toBe(true)
    const snapshot = await widgetManager.refreshWidget('py')
    expect(spawned).toEqual([['bun', 'run', 'widget']])
    expect(snapshot.scriptRan).toBe(true)
    expect(snapshot.validUntil).toBeNull()
    expect(snapshot.validityDefaulted).toBe(false)
  })

  it('treats an artifact with a widget block but no scripts.widget as static', async () => {
    seedArtifact('static-block', { html: '<p>x</p>' })
    spawnHolder.impl = () => {
      throw new Error('must not spawn')
    }
    expect(widgetManager.getWidget('static-block')?.hasScript).toBe(false)
    expect((await widgetManager.refreshWidget('static-block')).scriptRan).toBe(false)
  })

  it('falls back to one hour, flagged, when the script writes no widget.json', async () => {
    const dir = seedArtifact('lazy', { script: 'bun run widget.ts', html: '<p/>' })
    spawnHolder.impl = scriptWriting(dir, '<p>x</p>')
    const snapshot = await widgetManager.refreshWidget('lazy')
    expect(snapshot.validityDefaulted).toBe(true)
    expect(new Date(snapshot.validUntil!).getTime() - new Date(snapshot.generatedAt).getTime()).toBe(3_600_000)
    expect(fs.readFileSync(path.join(dir, 'widget.log'), 'utf-8')).toContain('not written by the script')
  })

  it('ignores a stale widget.json left over from a previous run', async () => {
    const dir = seedArtifact('stale', { script: 'bun run widget.ts', html: '<p/>' })
    fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify({ validUntil: '2999-01-01T00:00:00Z' }))
    spawnHolder.impl = scriptWriting(dir, '<p>x</p>') // writes no meta this time
    const snapshot = await widgetManager.refreshWidget('stale')
    expect(snapshot.validityDefaulted).toBe(true)
  })

  it('treats a validUntil already in the past as the fallback window', async () => {
    const dir = seedArtifact('past', { script: 'bun run widget.ts', html: '<p/>' })
    spawnHolder.impl = scriptWriting(dir, '<p>x</p>', { validUntil: '2000-01-01T00:00:00Z' })
    const snapshot = await widgetManager.refreshWidget('past')
    expect(snapshot.validityDefaulted).toBe(true)
    expect(Date.parse(snapshot.validUntil!)).toBeGreaterThan(Date.now())
  })

  it('records a failed script with a short retry window and keeps the old HTML', async () => {
    const dir = seedArtifact('macros', { script: 'bun run widget.ts', html: '<p>good</p>' })
    spawnHolder.impl = () => fakeProcess(1, { stderr: 'boom: upstream 500\n' })

    const snapshot = await widgetManager.refreshWidget('macros')

    expect(snapshot.lastError).toMatch(/exit code 1/)
    expect(snapshot.lastError).toMatch(/upstream 500/)
    expect(fs.readFileSync(path.join(dir, 'widget.html'), 'utf-8')).toBe('<p>good</p>')
    expect(new Date(snapshot.validUntil!).getTime() - new Date(snapshot.generatedAt).getTime()).toBe(300_000)
    expect(fs.readFileSync(path.join(dir, 'widget.log'), 'utf-8')).toContain('upstream 500')
  })

  it('kills the whole process group of a script that exceeds its timeout', async () => {
    seedArtifact('slow', { widget: { timeoutSeconds: 1 }, script: 'bun run widget.ts', html: '<p>x</p>' })
    let proc: FakeProc | null = null
    spawnHolder.impl = (_command, _args, options: any) => {
      // Its own group is what makes the negative-pid signal reach the script.
      expect(options.detached).toBe(true)
      proc = fakeProcess(0, { neverExit: true, pid: 4242 })
      return proc
    }
    // `bun run` only launches the script, so signalling the child alone leaves
    // the script itself running — free to overwrite widget.html later. Spied so
    // the negative pid never reaches a real process group on this machine.
    const signalled: Array<number | NodeJS.Signals | undefined> = []
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      signalled.push(pid, signal)
      setTimeout(() => proc?.emit('exit', null, 'SIGKILL'), 0)
      return true
    })
    try {
      const snapshot = await widgetManager.refreshWidget('slow')
      expect(signalled).toEqual([-4242, 'SIGKILL'])
      expect(snapshot.lastError).toMatch(/exceeded 1s/)
      // The exit was observed, so the queue did not advance on a guess.
      expect(snapshot.lastError).not.toMatch(/kill not confirmed/)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('rolls back a script that writes widget.html and then fails', async () => {
    const dir = seedArtifact('macros', { script: 'bun run widget.ts', html: '<p>good</p>' })
    fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'snapshots', 'snapshot.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        validUntil: null,
        validityDefaulted: false,
        htmlHash: createHash('sha256').update('<p>good</p>').digest('hex').slice(0, 16),
        renderedSizes: ['small-light@2x'],
        scriptRan: true,
        durationMs: 1,
        lastError: null,
      }),
    )
    spawnHolder.impl = () => {
      // Half a render, then a crash — the shape of a script that fetches, writes
      // and only then hits a bad response.
      fs.writeFileSync(path.join(dir, 'widget.html'), '<p>half-written</p>')
      return fakeProcess(1, { stderr: 'boom' })
    }

    const snapshot = await widgetManager.refreshWidget('macros')

    // What is on screen must survive a failed refresh.
    expect(fs.readFileSync(path.join(dir, 'widget.html'), 'utf-8')).toBe('<p>good</p>')
    expect(snapshot.lastError).toMatch(/exit code 1/)
    // The PNGs still match the restored HTML, so they are kept rather than
    // re-rendered — and never replaced with renders of the broken output.
    expect(snapshot.renderedSizes).toEqual(['small-light@2x'])
    expect(rasterMock).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dir, 'snapshots', '.previous-widget.html'))).toBe(false)
  })

  it('installs declared dependencies once before the first script run', async () => {
    const dir = seedArtifact('deps', { script: 'bun run widget.ts', html: '<p/>', dependencies: { dayjs: '^1' } })
    const spawned: string[][] = []
    spawnHolder.impl = (command, args) => {
      spawned.push([command, ...args])
      if (args[0] === 'install') {
        return fakeProcess(0, { onSpawn: () => fs.mkdirSync(path.join(dir, 'node_modules')) })
      }
      return scriptWriting(dir, '<p>x</p>', { validUntil: null })()
    }
    await widgetManager.refreshWidget('deps')
    await widgetManager.refreshWidget('deps')
    expect(spawned.filter((c) => c[1] === 'install')).toHaveLength(1)
    expect(spawned.filter((c) => c[1] === 'run')).toHaveLength(2)
  })

  it('a scriptless widget never expires', async () => {
    seedArtifact('static', { html: '<p>static</p>' })
    spawnHolder.impl = () => {
      throw new Error('must not spawn')
    }
    const snapshot = await widgetManager.refreshWidget('static')
    expect(snapshot.scriptRan).toBe(false)
    expect(snapshot.validUntil).toBeNull()
    expect(snapshot.lastError).toBeNull()
  })

  it('fails when the script leaves no widget.html behind', async () => {
    seedArtifact('empty', { script: 'bun run widget.ts' })
    spawnHolder.impl = () => fakeProcess(0)
    const snapshot = await widgetManager.refreshWidget('empty')
    expect(snapshot.lastError).toMatch(/widget\.html is missing/)
    expect(rasterMock).not.toHaveBeenCalled()
  })

  it('shares one in-flight refresh per widget', async () => {
    const dir = seedArtifact('macros', { script: 'bun run widget.ts', html: '<p>x</p>' })
    let spawns = 0
    spawnHolder.impl = () => {
      spawns++
      return scriptWriting(dir, '<p>x</p>', { validUntil: null })()
    }
    const [a, b] = await Promise.all([widgetManager.refreshWidget('macros'), widgetManager.refreshWidget('macros')])
    expect(a).toBe(b)
    expect(spawns).toBe(1)
  })

  it('rejects an artifact without a widget block and a bad slug', async () => {
    seedArtifact('main-dash', { widget: false, start: 'bun run index.js' })
    await expect(widgetManager.refreshWidget('main-dash')).rejects.toThrow(/does not expose a widget/)
    await expect(widgetManager.refreshWidget('../etc')).rejects.toThrow(/Invalid dashboard slug/)
  })

  describe('createWidget', () => {
    const templateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-home-'))
    const originalHome = process.env.HOME
    beforeEach(() => {
      const tpl = path.join(templateHome, '.claude/skills/widgets/templates/basic')
      fs.mkdirSync(tpl, { recursive: true })
      fs.writeFileSync(path.join(tpl, 'widget.html'), '<html>tpl</html>')
      fs.writeFileSync(path.join(tpl, 'widget.ts'), '// tpl')
      process.env.HOME = templateHome
    })
    afterEach(() => {
      process.env.HOME = originalHome
    })

    it('scaffolds a widget-only artifact for a new slug', async () => {
      const result = await widgetManager.createWidget('fresh', 'Fresh', 'desc', { size: 'medium' })
      expect(result.addedToDashboard).toBe(false)
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'fresh', 'package.json'), 'utf-8'))
      expect(pkg).toEqual({
        name: 'Fresh',
        description: 'desc',
        scripts: { widget: 'bun run widget.ts' },
        gamut: { widget: { size: 'medium', timeoutSeconds: 30 } },
      })
      expect(widgetManager.getWidget('fresh')).toMatchObject({ hasDashboard: false, hasScript: true, hasHtml: true, refreshOnTurnEnd: false })
    })

    it('records the refreshOnTurnEnd opt-in in the manifest', async () => {
      await widgetManager.createWidget('log', 'Log', '', { refreshOnTurnEnd: true })
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'log', 'package.json'), 'utf-8'))
      expect(pkg.gamut.widget).toEqual({ size: 'small', timeoutSeconds: 30, refreshOnTurnEnd: true })
      expect(widgetManager.getWidget('log')?.refreshOnTurnEnd).toBe(true)
    })

    it('adds the widget script to an existing dashboard beside its start script', async () => {
      seedArtifact('both', { widget: false, start: 'bun run serve.js' })
      await widgetManager.createWidget('both', 'ignored', '')
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'both', 'package.json'), 'utf-8'))
      expect(pkg.scripts).toEqual({ start: 'bun run serve.js', widget: 'bun run widget.ts' })
      expect(widgetManager.getWidget('both')).toMatchObject({ hasDashboard: true, hasScript: true })
      expect(dashboardManager.listDashboards().map((d) => d.slug)).toEqual(['both'])
    })

    it('adds a widget block to an existing dashboard without touching its other fields', async () => {
      seedArtifact('dash', { widget: false, start: 'bun run serve.js' })
      const result = await widgetManager.createWidget('dash', 'ignored', '', { withScript: false })
      expect(result.addedToDashboard).toBe(true)
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'dash', 'package.json'), 'utf-8'))
      expect(pkg.name).toBe('Artifact dash')
      // withScript:false → no widget command, so the widget stays static.
      expect(pkg.scripts).toEqual({ start: 'bun run serve.js' })
      expect(pkg.gamut.widget).toEqual({ size: 'small', timeoutSeconds: 30 })
      expect(fs.existsSync(path.join(tmpDir, 'dash', 'widget.ts'))).toBe(false)
      expect(widgetManager.getWidget('dash')).toMatchObject({ hasDashboard: true, hasScript: false })
      expect(dashboardManager.listDashboards().map((d) => d.slug)).toEqual(['dash'])
    })

    it('refuses to add a second widget to an artifact', async () => {
      seedArtifact('has-one', { html: '<p/>' })
      await expect(widgetManager.createWidget('has-one', 'x', '')).rejects.toThrow(/already exposes a widget/)
    })

    it('never writes the template over files that are already there', async () => {
      // The "already has a widget" guard reads the manifest, so anything that
      // makes a manifest read as "no widget" lands here — with hand-written
      // files in the directory that must survive.
      const dir = seedArtifact('handwritten', { widget: false, html: '<p>mine</p>' })
      fs.writeFileSync(path.join(dir, 'widget.ts'), '// mine')

      const result = await widgetManager.createWidget('handwritten', 'Handwritten', '')

      expect(result.kept.sort()).toEqual(['widget.html', 'widget.ts'])
      expect(fs.readFileSync(path.join(dir, 'widget.html'), 'utf-8')).toBe('<p>mine</p>')
      expect(fs.readFileSync(path.join(dir, 'widget.ts'), 'utf-8')).toBe('// mine')
      // The manifest is still updated: the artifact does now expose a widget.
      expect(widgetManager.getWidget('handwritten')).toMatchObject({ hasScript: true, hasHtml: true })
    })
  })
})
