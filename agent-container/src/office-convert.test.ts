import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'

type Spawn = (command: string, args: string[], options: { detached?: boolean }) => EventEmitter & { pid?: number }
const spawnHolder = vi.hoisted(() => ({ impl: null as Spawn | null }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: (command: string, args: string[], options: { detached?: boolean }) => spawnHolder.impl!(command, args, options),
}))

const { convertToPdf } = await import('./office-convert')

/** A soffice stand-in that writes `<name>.pdf` into --outdir and exits. */
function fakeSoffice(onRun: (args: string[]) => void = () => {}): Spawn {
  return (_command, args) => {
    const proc = new EventEmitter()
    const sofficeArgs = args.slice(3)
    onRun(sofficeArgs)
    const outDir = sofficeArgs[sofficeArgs.indexOf('--outdir') + 1]
    const input = sofficeArgs[sofficeArgs.length - 1]
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, `${path.basename(input, '.pptx')}.pdf`), `%PDF ${path.basename(input)}`)
    setTimeout(() => proc.emit('exit', 0, null), 5)
    return proc
  }
}

afterEach(() => {
  spawnHolder.impl = null
  vi.restoreAllMocks()
})

describe('convertToPdf', () => {
  it('refuses anything but pptx without starting LibreOffice', async () => {
    spawnHolder.impl = () => { throw new Error('spawned') }
    await expect(convertToPdf('/workspace/notes.docx')).resolves.toEqual({ ok: false, reason: 'unsupported' })
  })

  it('converts under a memory cap with a profile that blocks fetches and macros and keeps hidden slides', async () => {
    let profile = ''
    let script = ''
    spawnHolder.impl = (command, args, options) => {
      expect(command).toBe('sh')
      expect(options.detached).toBe(true)
      script = args[1]
      return fakeSoffice((sofficeArgs) => {
        const dir = sofficeArgs[0].replace('-env:UserInstallation=file://', '')
        profile = fs.readFileSync(path.join(dir, 'user', 'registrymodifications.xcu'), 'utf8')
      })(command, args, options)
    }

    const result = await convertToPdf('/workspace/q3.pptx')

    expect(result).toEqual({ ok: true, pdf: Buffer.from('%PDF q3.pptx') })
    expect(script).toMatch(/^ulimit -v \d+ && exec soffice/)
    for (const [group, key] of [
      ['Security/Scripting', 'BlockUntrustedRefererLinks'],
      ['Security/Scripting', 'DisableMacrosExecution'],
      ['Filter/PDF/Export', 'ExportHiddenSlides'],
    ]) {
      expect(profile).toContain(`<item oor:path="/org.openoffice.Office.Common/${group}"><prop oor:name="${key}" oor:op="fuse"><value>true</value>`)
    }
  })

  it('runs one conversion at a time', async () => {
    let running = 0
    let peak = 0
    spawnHolder.impl = (command, args, options) => {
      running++
      peak = Math.max(peak, running)
      const proc = fakeSoffice()(command, args, options)
      proc.once('exit', () => { running-- })
      return proc
    }

    await Promise.all([convertToPdf('/workspace/a.pptx'), convertToPdf('/workspace/b.pptx')])

    expect(peak).toBe(1)
  })

  it('fails a conversion that cannot start without stopping the next one', async () => {
    spawnHolder.impl = () => {
      const proc = new EventEmitter()
      setTimeout(() => proc.emit('error', new Error('spawn EAGAIN')), 5)
      return proc
    }
    await expect(convertToPdf('/workspace/a.pptx')).rejects.toThrow('EAGAIN')

    spawnHolder.impl = fakeSoffice()
    await expect(convertToPdf('/workspace/b.pptx')).resolves.toMatchObject({ ok: true })
  })

  it('skips a deck whose preview was closed while it waited', async () => {
    const spawned: string[] = []
    spawnHolder.impl = fakeSoffice((args) => spawned.push(path.basename(args[args.length - 1])))
    const closed = new AbortController()

    const first = convertToPdf('/workspace/open.pptx')
    const second = convertToPdf('/workspace/closed.pptx', closed.signal)
    closed.abort()

    await expect(second).resolves.toEqual({ ok: false, reason: 'timeout' })
    await first
    expect(spawned).toEqual(['open.pptx'])
  })

  it('reports a deck LibreOffice could not read', async () => {
    spawnHolder.impl = () => {
      const proc = new EventEmitter()
      setTimeout(() => proc.emit('exit', 1, null), 5)
      return proc
    }
    await expect(convertToPdf('/workspace/broken.pptx')).resolves.toEqual({ ok: false, reason: 'unreadable' })
  })
})

describe('the 20 s budget from arrival', () => {
  /** Arrival is now, and LibreOffice starts with `left` ms of the budget remaining. */
  function startWith(left: number) {
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0).mockReturnValue(t0 + 20_000 - left)
  }

  it('answers timeout without starting LibreOffice for a deck that waited past it', async () => {
    const spawned: string[] = []
    const t0 = Date.now()
    spawnHolder.impl = (command, args, options) => {
      // The first conversion takes the whole budget of the deck queued behind it.
      vi.spyOn(Date, 'now').mockReturnValue(t0 + 25_000)
      return fakeSoffice((a) => spawned.push(path.basename(a[a.length - 1])))(command, args, options)
    }

    // Both arrive together; whichever reaches the queue second waits out its budget.
    const results = await Promise.all([convertToPdf('/workspace/a.pptx'), convertToPdf('/workspace/b.pptx')])

    expect(spawned).toHaveLength(1)
    const waited = results[spawned[0] === 'a.pptx' ? 1 : 0]
    expect(waited).toEqual({ ok: false, reason: 'timeout' })
    expect(results[spawned[0] === 'a.pptx' ? 0 : 1]).toMatchObject({ ok: true })
  })

  it('kills the whole process group when the budget runs out', async () => {
    const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() })
    spawnHolder.impl = () => proc
    const signalled: Array<number | string | undefined> = []
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      signalled.push(pid, signal)
      setTimeout(() => proc.emit('exit', null, 'SIGKILL'), 0)
      return true
    })
    startWith(10)

    await expect(convertToPdf('/workspace/slow.pptx')).resolves.toEqual({ ok: false, reason: 'timeout' })
    expect(signalled).toEqual([-4242, 'SIGKILL'])
  })

  it('gives up on a kill that never exits, so the next deck still converts', async () => {
    spawnHolder.impl = () => Object.assign(new EventEmitter(), { pid: 4243, kill: vi.fn() })
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    startWith(10)

    await expect(convertToPdf('/workspace/stuck.pptx')).resolves.toEqual({ ok: false, reason: 'timeout' })
    vi.mocked(Date.now).mockRestore()
    spawnHolder.impl = fakeSoffice()
    await expect(convertToPdf('/workspace/next.pptx')).resolves.toMatchObject({ ok: true })
  })
})
