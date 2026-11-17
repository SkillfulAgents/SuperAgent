/**
 * The "save a photo from a web page" flow against the real machine, the way
 * agent-desktop's guide does it: Safari, a local page with an image that has
 * no ref, its bounds from `find`, a physical right-click at that screen point
 * (`mouse-click --xy --button right --headed`), the open menu read as a
 * surface, and its "Save Image to Downloads" clicked by ref.
 *
 * Skipped unless COMPUTER_USE_REAL_SAFARI=1, on macOS, with Accessibility and
 * Screen Recording granted to the terminal. It opens a Safari window, moves
 * the real pointer, and saves (then deletes) one file in ~/Downloads. Do not
 * run it while sharing your screen.
 *
 *   COMPUTER_USE_REAL_SAFARI=1 npx vitest run src/shared/lib/computer-use/executor.safari.real.test.ts
 */
import { execFile } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const REAL = process.env.COMPUTER_USE_REAL_SAFARI === '1' && process.platform === 'darwin'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ computerUse: { showCursor: true, inputMode: 'headed' } }),
}))

const execFileAsync = promisify(execFile)

interface Envelope {
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message: string }
  open_menu?: unknown
}

interface Node {
  role?: string
  name?: string
  ref_id?: string | null
  children?: Node[]
}

function findNode(node: unknown, match: (node: Node) => boolean): Node | undefined {
  if (!node || typeof node !== 'object') return undefined
  const current = node as Node & { tree?: Node }
  if (match(current)) return current
  for (const child of [...(current.children ?? []), ...(current.tree ? [current.tree] : [])]) {
    const found = findNode(child, match)
    if (found) return found
  }
  return undefined
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return undefined
}

describe.skipIf(!REAL)('saving an image from a web page in Safari', { timeout: 120_000 }, () => {
  let executor: typeof import('./executor')
  let dataDir = ''
  let pageDir = ''
  const tag = crypto.randomBytes(4).toString('hex')
  const imageName = `gamut-cu-photo-${tag}.png`
  const title = `Gamut computer use ${tag}`
  const saved = path.join(os.homedir(), 'Downloads', imageName)
  const agent = { sessionId: `real-safari-${tag}`, agentSlug: 'agent-safari', label: 'Spike Agent Safari', accent: '#2B79FA' }
  let windowId = ''

  const run = async (method: string, params: Record<string, unknown>) => {
    const result = await executor.executeComputerUseCommand(method, params, agent)
    return { ...result, envelope: JSON.parse(result.output) as Envelope & Record<string, unknown> }
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamut-computer-use-'))
    pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamut-cu-page-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    executor = await import('./executor')
    expect(await executor.checkComputerUsePermissions(), 'Accessibility must be granted to this terminal').toBeNull()

    const photo = new PNG({ width: 240, height: 240 })
    for (let i = 0; i < photo.data.length; i += 4) photo.data.set([43, 121, 250, 255], i)
    fs.writeFileSync(path.join(pageDir, imageName), PNG.sync.write(photo))
    fs.writeFileSync(path.join(pageDir, 'page.html'), `<!doctype html><title>${title}</title>
<body style="font: 16px -apple-system; padding: 40px"><h1>Profile</h1>
<img src="${imageName}" alt="Profile photo ${tag}" width="240" height="240"></body>`)
    await execFileAsync('/usr/bin/open', ['-a', 'Safari', path.join(pageDir, 'page.html')])

    windowId = (await waitFor(async () => {
      const { envelope } = await run('list-windows', { app: 'Safari' })
      const windows = (envelope.data ?? []) as unknown as Array<{ id: string; title?: string }>
      return windows.find((window) => window.title?.includes(title))?.id
    }, 15_000)) ?? ''
    expect(windowId, 'the test page opened in a Safari window').not.toBe('')
  })

  afterAll(async () => {
    if (windowId) await executor?.executeComputerUseCommand('press', { combo: 'cmd+w', window_id: windowId }, agent).catch(() => {})
    await executor?.endComputerUseSessions()
    fs.rmSync(saved, { force: true })
    if (pageDir) fs.rmSync(pageDir, { recursive: true, force: true })
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('right-clicks the image at its screen point and saves it from the menu', async () => {
    const found = await run('find', { app: 'Safari', role: 'image', name: `Profile photo ${tag}`, first: true, timeout_ms: 15_000 })
    expect(found.envelope.ok, JSON.stringify(found.envelope)).toBe(true)
    const bounds = (found.envelope.data?.match as { bounds?: { x: number; y: number; width: number; height: number } })?.bounds
    expect(bounds, JSON.stringify(found.envelope)).toBeDefined()
    const xy = `${Math.round(bounds!.x + bounds!.width / 2)},${Math.round(bounds!.y + bounds!.height / 2)}`

    const rightClick = await run('mouse-click', { xy, button: 'right', headed: true })
    expect(rightClick.app).toBe('Safari')
    const menu = await waitFor(async () => {
      const { envelope } = await run('snapshot', { app: 'Safari', surface: 'menu' })
      return envelope.ok ? envelope.data : undefined
    }, 5_000)
    const save = findNode(menu, (node) => node.role === 'menuitem' && /^Save Image to/.test(node.name ?? ''))
    expect(save?.ref_id, `menu: ${JSON.stringify(menu)}`).toBeTruthy()

    const click = await run('click', { ref: save!.ref_id })
    expect(click.envelope.ok, JSON.stringify(click.envelope)).toBe(true)
    expect(await waitFor(() => (fs.existsSync(saved) ? true : undefined), 10_000), `${saved} was saved`).toBe(true)
  })
})
