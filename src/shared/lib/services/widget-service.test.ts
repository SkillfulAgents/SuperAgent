// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-service-'))

vi.mock('@shared/lib/utils/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/utils/file-storage')>()
  return {
    ...actual,
    getAgentWorkspaceDir: (slug: string) => path.join(tmpRoot, slug, 'workspace'),
  }
})

const {
  hashWidgetHtml,
  listWidgetsFromFilesystem,
  readWidgetFromFilesystem,
  readWidgetHtml,
  readWidgetLogTail,
  renderWidgetDocument,
  resolveWidgetPath,
  widgetSnapshotPngPath,
} = await import('./widget-service')
const { listArtifactsFromFilesystem, listArtifactsAndWidgets } = await import('./artifact-service')
const { WorkspaceFileError, agentRegistry } = await import('@shared/lib/agent-actor')

const AGENT = 'agent-1'

function seed(slug: string, files: Record<string, string>): string {
  const dir = path.join(tmpRoot, AGENT, 'workspace', 'artifacts', slug)
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

const manifest = (
  opts: { start?: string; script?: string; widget?: Record<string, unknown> | false; name?: string } = {},
) => {
  const scripts = {
    ...(opts.start ? { start: opts.start } : {}),
    ...(opts.script ? { widget: opts.script } : {}),
  }
  return JSON.stringify({
    name: opts.name ?? 'Nutrition',
    description: 'kcal today',
    ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
    ...(opts.widget === false ? {} : { gamut: { widget: { size: 'medium', ...(opts.widget ?? {}) } } }),
  })
}

describe('widget-service', () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmpRoot, AGENT), { recursive: true, force: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists every artifact with a widget; the dashboard lister keeps only those with a server', async () => {
    seed('macros', {
      'package.json': manifest({ name: 'Macros', script: 'bun run widget.ts' }),
      'widget.html': '<p>1,820 kcal</p>',
      'widget.ts': '',
    })
    seed('nutrition', { 'package.json': manifest({ start: 'bun run serve.js' }), 'widget.html': '<p/>' })
    seed('plain', { 'package.json': JSON.stringify({ name: 'Plain', scripts: { start: 'bun run index.js' } }) })

    const widgets = (await listWidgetsFromFilesystem(AGENT)).sort((a, b) => a.slug.localeCompare(b.slug))
    expect(widgets.map((w) => [w.slug, w.hasDashboard, w.hasScript])).toEqual([
      ['macros', false, true],
      ['nutrition', true, false],
    ])
    expect(widgets[0]).toMatchObject({
      name: 'Macros',
      description: 'kcal today',
      size: 'medium',
      hasHtml: true,
      htmlHash: hashWidgetHtml('<p>1,820 kcal</p>'),
      generatedAt: null,
      validUntil: null,
      isStale: true,
      refreshing: false,
      refreshOnTurnEnd: false,
    })

    const dashboards = (await listArtifactsFromFilesystem(AGENT)).map((d) => d.slug).sort()
    expect(dashboards).toEqual(['nutrition', 'plain'])

    // The agents-list path reads each manifest once and answers both
    // questions from it. Same answers as the two separate listings, at a
    // third of the filesystem operations.
    const both = await listArtifactsAndWidgets(AGENT)
    expect(both.dashboards.map((d) => d.slug).sort()).toEqual(dashboards)
    expect(both.widgets.sort((a, b) => a.slug.localeCompare(b.slug))).toEqual(widgets)
  })

  it('reads scripts.widget to decide scripted vs static, without touching the disk', async () => {
    // Any command counts, and a widget.ts nobody declared does not.
    seed('custom', { 'package.json': manifest({ script: 'python3 -m tools.build' }), 'widget.html': '<p/>' })
    seed('blank', { 'package.json': manifest({ script: '   ' }), 'widget.html': '<p/>' })
    seed('undeclared', { 'package.json': manifest(), 'widget.html': '<p/>', 'widget.ts': '// not declared' })
    expect((await readWidgetFromFilesystem(AGENT, 'custom'))?.hasScript).toBe(true)
    expect((await readWidgetFromFilesystem(AGENT, 'blank'))?.hasScript).toBe(false)
    expect((await readWidgetFromFilesystem(AGENT, 'undeclared'))?.hasScript).toBe(false)
  })

  it('reports the refreshOnTurnEnd opt-in from the manifest', async () => {
    seed('opted-in', { 'package.json': manifest({ widget: { refreshOnTurnEnd: true } }), 'widget.html': '<p/>' })
    seed('default', { 'package.json': manifest(), 'widget.html': '<p/>' })
    expect((await readWidgetFromFilesystem(AGENT, 'opted-in'))?.refreshOnTurnEnd).toBe(true)
    expect((await readWidgetFromFilesystem(AGENT, 'default'))?.refreshOnTurnEnd).toBe(false)
  })

  it('tails widget.log for a repair session, and is quiet when there is none', async () => {
    seed('macros', { 'package.json': manifest(), 'widget.html': '<p/>', 'widget.log': `head\n${'x'.repeat(50)}\ntail line\n` })
    const tail = await readWidgetLogTail(AGENT, 'macros', 20)
    expect(tail).toHaveLength(20)
    expect(tail?.endsWith('tail line')).toBe(true)
    expect(await readWidgetLogTail(AGENT, 'no-such-artifact')).toBeNull()
    expect(await readWidgetLogTail(AGENT, '../escape')).toBeNull()
  })

  it('reads snapshot.json and reports freshness against it', async () => {
    const html = '<p>fresh</p>'
    seed('macros', {
      'package.json': manifest({ script: 'bun run widget.ts' }),
      'widget.html': html,
      'snapshots/snapshot.json': JSON.stringify({
        generatedAt: '2026-09-07T10:00:00Z',
        validUntil: '2999-01-01T00:00:00Z',
        validityDefaulted: false,
        htmlHash: hashWidgetHtml(html),
        renderedSizes: ['small-light@2x'],
        scriptRan: true,
        durationMs: 5,
        lastError: null,
      }),
    })
    const widget = await readWidgetFromFilesystem(AGENT, 'macros')
    expect(widget).toMatchObject({ isStale: false, generatedAt: '2026-09-07T10:00:00Z', lastError: null })

    // The run rewrote widget.html after the snapshot → stale again.
    fs.writeFileSync(path.join(tmpRoot, AGENT, 'workspace', 'artifacts', 'macros', 'widget.html'), '<p>edited</p>')
    expect((await readWidgetFromFilesystem(AGENT, 'macros'))?.isStale).toBe(true)
  })

  it('ignores a corrupt snapshot.json rather than failing the listing', async () => {
    seed('macros', { 'package.json': manifest(), 'widget.html': '<p/>', 'snapshots/snapshot.json': '{nope' })
    const widget = await readWidgetFromFilesystem(AGENT, 'macros')
    expect(widget?.generatedAt).toBeNull()
    expect(widget?.isStale).toBe(true)
  })

  it('returns null for a dashboard without a widget, a missing dir, or an unreadable manifest', async () => {
    seed('dash', { 'package.json': manifest({ start: 'bun run x', widget: false }) })
    seed('unreadable', { 'package.json': '{nope' })
    expect(await readWidgetFromFilesystem(AGENT, 'dash')).toBeNull()
    expect(await readWidgetFromFilesystem(AGENT, 'missing')).toBeNull()
    expect(await readWidgetFromFilesystem(AGENT, 'unreadable')).toBeNull()
  })

  it('a config value the schema dislikes falls back to the default instead of hiding the widget', async () => {
    // The gamut block is the marker that says the artifact HAS a widget, so a
    // strict parse would turn one bad field into a widget that disappears from
    // the app while the container still lists it.
    seed('odd', { 'package.json': JSON.stringify({ gamut: { widget: { size: 'huge' } } }), 'widget.html': '<p/>' })
    expect(await readWidgetFromFilesystem(AGENT, 'odd')).toMatchObject({ slug: 'odd', size: 'small' })
  })

  it('refuses slugs and segments that escape the artifacts dir', () => {
    // Pure string work: the slug is domain validation, the result a workspace
    // path. Containment of that path is the actor's job, tested below.
    expect(resolveWidgetPath(AGENT, '../secrets')).toBeNull()
    expect(resolveWidgetPath(AGENT, 'Macros')).toBeNull()
    expect(resolveWidgetPath(AGENT, 'macros', '..', '..', 'x')).toBeNull()
    expect(resolveWidgetPath(AGENT, 'macros', 'nested/file')).toBeNull()
    expect(resolveWidgetPath(AGENT, 'macros')).toBe('artifacts/macros')
    expect(widgetSnapshotPngPath(AGENT, 'macros', 'small', 'dark', 3)).toBe(
      'artifacts/macros/snapshots/small-dark@3x.png',
    )
  })

  it('refuses a file the agent symlinked out of its own workspace', async () => {
    // The artifact dir is inside the workspace the container bind-mounts, so
    // the agent can plant the link itself. The paths are fine — valid slug,
    // workspace-relative — and it is the actor that refuses to follow them.
    const secret = path.join(tmpRoot, 'outside-secret.txt')
    fs.writeFileSync(secret, 'host-only')
    const dir = seed('macros', { 'package.json': manifest({ script: 'bun run widget.ts' }) })
    fs.symlinkSync(secret, path.join(dir, 'widget.html'))
    fs.symlinkSync(secret, path.join(dir, 'widget.log'))
    fs.symlinkSync(secret, path.join(dir, 'snapshots', 'small-dark@3x.png'))

    const { files } = agentRegistry.get(AGENT)
    const htmlPath = resolveWidgetPath(AGENT, 'macros', 'widget.html')
    expect(htmlPath).toBe('artifacts/macros/widget.html')
    await expect(files.getDoc(htmlPath!)).rejects.toBeInstanceOf(WorkspaceFileError)
    const pngPath = widgetSnapshotPngPath(AGENT, 'macros', 'small', 'dark', 3)
    await expect(files.getDoc(pngPath!)).rejects.toBeInstanceOf(WorkspaceFileError)
    // The readers turn that refusal into "absent", as they always have.
    expect(await readWidgetHtml(AGENT, 'macros')).toBeNull()
    expect(await readWidgetLogTail(AGENT, 'macros')).toBeNull()
  })

  it('refuses to read through an artifacts dir the agent replaced with a link', async () => {
    // A swapped `artifacts` used to be the cross-agent read that a check
    // anchored on `artifacts` itself would pass: resolving both sides against
    // the link makes its target the boundary. The actor anchors on the
    // workspace, which the agent cannot swap from inside the container.
    const victim = path.join(tmpRoot, 'agent-2', 'workspace', 'artifacts', 'daily-macros')
    fs.mkdirSync(victim, { recursive: true })
    fs.writeFileSync(path.join(victim, 'package.json'), manifest({ script: 'bun run widget.ts' }))
    fs.writeFileSync(path.join(victim, 'widget.html'), '<p>other agent</p>')

    const ourWorkspace = path.join(tmpRoot, AGENT, 'workspace')
    fs.mkdirSync(ourWorkspace, { recursive: true })
    fs.symlinkSync(path.join(tmpRoot, 'agent-2', 'workspace', 'artifacts'), path.join(ourWorkspace, 'artifacts'))

    expect(resolveWidgetPath(AGENT, 'daily-macros', 'widget.html')).toBe('artifacts/daily-macros/widget.html')
    expect(await readWidgetHtml(AGENT, 'daily-macros')).toBeNull()
    expect(await readWidgetFromFilesystem(AGENT, 'daily-macros')).toBeNull()
    // The listing answers empty rather than with the other agent's artifacts.
    // Empty, not an error: the agents list fans out over every agent, and a
    // link one agent planted must not take the whole list down.
    expect(await listWidgetsFromFilesystem(AGENT)).toEqual([])
    expect(await listArtifactsAndWidgets(AGENT)).toEqual({ dashboards: [], widgets: [] })
  })

  it('a filesystem failure the actor does not map also reads as an empty listing', async () => {
    // Descriptor exhaustion, an I/O error: not the actor's error type, but the
    // agents list must still come back with this agent's artifacts as none.
    seed('macros', { 'package.json': manifest({ script: 'bun run widget.ts' }) })
    const { files } = agentRegistry.get(AGENT)
    const failure = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    const list = vi.spyOn(files, 'list').mockRejectedValue(failure)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await listWidgetsFromFilesystem(AGENT)).toEqual([])
      expect(await listArtifactsAndWidgets(AGENT)).toEqual({ dashboards: [], widgets: [] })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      list.mockRestore()
      warn.mockRestore()
    }
  })

  it('carries the policy inside the document the app inlines', () => {
    // The app cannot frame the URL (the renderer is file:// in a packaged
    // build), so the restrictions have to travel in the document itself.
    const withHead = renderWidgetDocument('<html><head><title>x</title></head><body/></html>', 'dark')
    expect(withHead).toContain('<html data-theme="dark">')
    expect(withHead).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';/)
    // frame-ancestors is ignored in a meta tag; the response header keeps it.
    expect(withHead).not.toContain('frame-ancestors')

    // A fragment with no head of its own still gets one.
    expect(renderWidgetDocument('<p>bare</p>', 'light')).toMatch(
      /<html data-theme="light"><head><meta http-equiv="Content-Security-Policy"/,
    )
    // An authored policy does not displace ours. The app inlines this document,
    // so the response header no longer covers the frame — were ours skipped,
    // an authored `default-src *` would be the only policy in force. Browsers
    // enforce two policies as an intersection, so the author can only restrict.
    const authored = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>'
    const rendered = renderWidgetDocument(authored, 'dark')
    expect(rendered.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(2)
    expect(rendered).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';/)
  })

  it.each([
    ['a comment', '<!-- Widget styles belong in <head>. --><html><head></head><body><p>value</p></body></html>'],
    ['a quoted attribute', '<html><head data-note="a > b"></head><body><p>value</p></body></html>'],
    ['CSS with an omitted head tag', '<html><style>/* <head> */</style><body><p>value</p></body></html>'],
    ['an inert template', '<html><template><head></head></template><body><p>value</p></body></html>'],
    ['a fragment', '<p>value</p>'],
  ])('places an active CSP before authored content containing %s', (_name, html) => {
    const document = new DOMParser().parseFromString(renderWidgetDocument(html, 'dark'), 'text/html')
    // A string match also finds policies trapped in comments, attributes,
    // raw text, or template contents. Check the parsed document instead.
    const policy = document.head.firstElementChild
    expect(policy?.tagName).toBe('META')
    expect(policy?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(policy?.getAttribute('content')).toContain("default-src 'none'")
    expect(document.body.textContent).toContain('value')
  })

  it.each(['light', 'dark'] as const)('preserves metadata and content in the %s document', (scheme) => {
    const html = '<!DOCTYPE html><html lang="en"><head><title>Widget</title><style>body { color: red; }</style></head><body><p>value</p></body></html>'
    const document = new DOMParser().parseFromString(renderWidgetDocument(html, scheme), 'text/html')
    expect(document.compatMode).toBe('CSS1Compat')
    expect(document.querySelectorAll('html')).toHaveLength(1)
    expect(document.documentElement.getAttribute('data-theme')).toBe(scheme)
    expect(document.documentElement.getAttribute('lang')).toBe('en')
    expect(document.head.querySelector('title')?.textContent).toBe('Widget')
    expect(document.head.querySelector('style')?.textContent).toBe('body { color: red; }')
    expect(document.body.textContent).toBe('value')
  })
})
