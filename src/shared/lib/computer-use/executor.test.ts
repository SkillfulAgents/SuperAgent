import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PNG } from 'pngjs'
import type { AgentDesktopEnvelope } from './agent-desktop'

// Every agent-desktop run goes through this mock: the test answers by
// command, with an envelope or, for text output such as --help, a string.
type Answer = AgentDesktopEnvelope | string
const runs: string[][] = []
let answer: (args: string[]) => Answer
const run = vi.fn(async (args: readonly string[], _options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Answer> => {
  runs.push([...args])
  return answer([...args])
})

vi.mock('./agent-desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-desktop')>()
  const envelopeOf = async (args: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => {
    const result = await run(args, options)
    if (typeof result === 'string') throw new Error('printed no result')
    return result
  }
  return {
    ...actual,
    runAgentDesktop: envelopeOf,
    runAgentDesktopOutput: async (args: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => {
      const result = await run(args, options)
      return typeof result === 'string'
        ? { stdout: result, envelope: null, code: 0, stderr: '' }
        : { stdout: JSON.stringify(result), envelope: result, code: 0, stderr: '' }
    },
    runAgentDesktopOrThrow: async (args: readonly string[]) => {
      const envelope = await envelopeOf(args)
      if (!envelope.ok) throw new Error(envelope.error?.code ?? 'ERROR')
      return envelope.data
    },
  }
})

const activated: string[] = []
vi.mock('./windows-start-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./windows-start-menu')>()
  return {
    ...actual,
    startMenuApps: async () => [{ name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }],
    activateStartMenuApp: (app: { appId: string }) => { activated.push(app.appId) },
  }
})

let computerUseSettings: Record<string, unknown> | undefined
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => ({ computerUse: computerUseSettings }),
}))

const {
  executeComputerUseCommand,
  endComputerUseSessions,
  resolveComputerUseTargetApp,
  checkComputerUsePermissions,
  cursorLabel,
} = await import('./executor')

const ok = (command: string, data: unknown): AgentDesktopEnvelope => ({ version: '2.6', ok: true, command, data })

/** The command a run carries, after the session. */
function commandOf(args: string[]): string {
  return args[0] === '--session' ? args[2] : args[0]
}

let sessionCount = 0
function defaultAnswer(args: string[]): Answer {
  if (args[0] === 'session' && args[1] === 'start') return ok('session', { session_id: `ads-${++sessionCount}` })
  const command = commandOf(args)
  if (command === 'snapshot') return ok('snapshot', { app: 'Finder', window: { id: 'w-9' }, snapshot_id: 'snapA', ref_count: 1, complete: true, tree: {} })
  if (command === 'list-windows') return ok('list-windows', [{ id: 'w-7', title: 'Notes', app_name: 'Notes', pid: 4 }])
  return ok(command, { action: command, disposition: { delivery: 'delivered_verified', retry: 'unsafe' } })
}

const caller = (sessionId = 'session-1') => ({ sessionId, agentSlug: 'agent-a', label: 'Invoice Bot', accent: '#2B79FA' })

function useRun(implementation: (args: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Answer>): void {
  run.mockImplementation(implementation)
}

beforeEach(async () => {
  await endComputerUseSessions()
  sessionCount = 0
  runs.length = 0
  useRun(async (args) => {
    runs.push([...args])
    return answer([...args])
  })
  run.mockClear()
  computerUseSettings = undefined
  answer = defaultAnswer
})

describe('executeComputerUseCommand', () => {
  it('starts one agent-desktop session per app session, with the agent\'s cursor', async () => {
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())

    const starts = runs.filter((args) => args[0] === 'session' && args[1] === 'start')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toContain('--name=Invoice Bot')
    expect(runs).toContainEqual(['--session', 'ads-1', 'cursor-overlay', 'enable', '--label=Invoice Bot', '--max-words=6', '--accent=#2B79FA'])
    const snapshots = runs.filter((args) => commandOf(args) === 'snapshot')
    expect(snapshots.every((args) => args[0] === '--session' && args[1] === 'ads-1')).toBe(true)
  })

  it('keeps sessions apart, so one session never resolves another\'s refs', async () => {
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller('session-1'))
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller('session-2'))

    const sessionsUsed = new Set(runs.filter((args) => commandOf(args) === 'snapshot').map((args) => args[1]))
    expect(sessionsUsed).toEqual(new Set(['ads-1', 'ads-2']))
  })

  it('shows no cursor when the user turned cursors off, and takes it away when they do', async () => {
    computerUseSettings = { showCursor: false }
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())
    expect(runs.some((args) => args.includes('cursor-overlay'))).toBe(false)

    computerUseSettings = { showCursor: true }
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())
    expect(runs.some((args) => args.includes('cursor-overlay') && args.includes('enable'))).toBe(true)

    computerUseSettings = { showCursor: false }
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())
    expect(runs).toContainEqual(['--session', 'ads-1', 'cursor-overlay', 'disable'])
  })

  it('runs a tool\'s command line as given, adding only the session', async () => {
    await executeComputerUseCommand('snapshot', { app: 'Finder', skeleton: true }, caller())
    await executeComputerUseCommand('click', { ref: '@snapA:e1' }, caller())
    await executeComputerUseCommand('run', { args: ['double-click', '@snapA:e2'] }, caller())

    expect(runs.find((args) => commandOf(args) === 'snapshot')).toEqual(['--session', 'ads-1', 'snapshot', '--app=Finder', '--skeleton'])
    expect(runs.find((args) => commandOf(args) === 'click')).toEqual(['--session', 'ads-1', 'click', '--', '@snapA:e1'])
    expect(runs.find((args) => commandOf(args) === 'double-click')).toEqual(['--session', 'ads-1', 'double-click', '@snapA:e2'])
  })

  it('hands back what agent-desktop printed, envelope or text', async () => {
    const envelope = { version: '2.6', ok: false, command: 'click', error: { code: 'STALE_REF', message: 'gone', disposition: { delivery: 'not_delivered', retry: 'safe' } } }
    answer = (args) => args[0] === 'session' ? defaultAnswer(args) : envelope
    expect((await executeComputerUseCommand('click', { ref: '@snapZ:e1' }, caller())).output).toBe(JSON.stringify(envelope))

    answer = (args) => args[0] === 'session' ? defaultAnswer(args) : 'Usage: agent-desktop mouse-click [OPTIONS] --xy <XY>'
    expect((await executeComputerUseCommand('run', { args: ['mouse-click', '--help'] }, caller())).output).toMatch(/^Usage: agent-desktop mouse-click/)
  })

  it('passes a long result through whole', async () => {
    const long = ok('find', { matches: 'x'.repeat(70_000) })
    answer = (args) => args[0] === 'session' ? defaultAnswer(args) : long

    const result = await executeComputerUseCommand('find', { app: 'Finder' }, caller())

    expect(result.output).toBe(JSON.stringify(long))
  })

  it('passes --headed through when the user allows physical input', async () => {
    await executeComputerUseCommand('mouse-click', { xy: '10,20', headed: true }, caller())

    expect(runs.find((args) => commandOf(args) === 'mouse-click')).toEqual(['--session', 'ads-1', 'mouse-click', '--xy=10,20', '--headed'])
  })

  it('refuses --headed when the user does not allow physical input, and runs nothing', async () => {
    computerUseSettings = { inputMode: 'headless' }

    await expect(executeComputerUseCommand('run', { args: ['double-click', '--headed', '@snapA:e2'] }, caller()))
      .rejects.toThrow(/Physical Input: Never/)
    expect(runs.some((args) => commandOf(args) === 'double-click')).toBe(false)
    // Without --headed, the command runs headless as given.
    await executeComputerUseCommand('run', { args: ['double-click', '@snapA:e2'] }, caller())
    expect(runs.some((args) => commandOf(args) === 'double-click')).toBe(true)
  })

  it('stops a command that outlives its own budget, and reports its delivery as unknown', async () => {
    const { AgentDesktopTimeoutError } = await vi.importActual<typeof import('./agent-desktop')>('./agent-desktop')
    const timeouts: Array<number | undefined> = []
    useRun(async (args, options) => {
      runs.push([...args])
      if (commandOf([...args]) !== 'type') return answer([...args])
      timeouts.push(options?.timeoutMs)
      throw new AgentDesktopTimeoutError('type', options?.timeoutMs ?? 0)
    })

    const result = await executeComputerUseCommand('type', { ref: '@snapA:e2', text: 'x'.repeat(2000) }, caller())

    // agent-desktop gives typing 5s plus 30 ms a character; the app waits that long and more.
    expect(timeouts[0]).toBeGreaterThan(5000 + 30 * 2000)
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: { code: 'TIMEOUT', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } } })
  })

  it('drops a command still queued past its start time, unrun', async () => {
    await expect(executeComputerUseCommand('click', { ref: '@snapA:e1' }, caller(), { startBy: Date.now() - 1000 }))
      .rejects.toThrow(/was not run.*Nothing was done/)
    expect(runs.some((args) => commandOf(args) === 'click')).toBe(false)
  })

  it('reports the app a ref-only action acted in, from the snapshot that made the ref', async () => {
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())
    const result = await executeComputerUseCommand('click', { ref: '@snapA:e1' }, caller())

    expect(result.app).toBe('Finder')
  })

  it('refuses what only the app may set', async () => {
    await expect(executeComputerUseCommand('run', { args: ['click', '--session', 'other', '@x:e1'] }, caller()))
      .rejects.toThrow(/set by the app/)
    await expect(executeComputerUseCommand('run', { args: ['launch', '--cdp', 'Slack'] }, caller()))
      .rejects.toThrow(/not available to agents/)
    await expect(executeComputerUseCommand('run', { args: ['screenshot', '--app', 'Finder', '/tmp/x.png'] }, caller()))
      .rejects.toThrow(/no output path/)
    expect(runs.some((args) => args[0] === '--session')).toBe(false)
  })

  it('refuses one call that acts in two apps', async () => {
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())
    const batch = JSON.stringify([{ command: 'click', args: { ref_id: '@snapA:e1' } }, { command: 'press', args: { combo: 'x', app: 'Notes' } }])

    await expect(executeComputerUseCommand('run', { args: ['batch', batch] }, caller())).rejects.toThrow(/one app/)
  })
})

describe('screenshots', () => {
  // Safari's window: 400 × 300 points at (738, 30), captured at 2× inside its shadow.
  const bounds = { x: 738, y: 30, width: 400, height: 300 }

  function capture(): string {
    const margins = { left: 112, top: 78, right: 112, bottom: 150 }
    const png = new PNG({ width: 800 + margins.left + margins.right, height: 600 + margins.top + margins.bottom })
    png.data.fill(0)
    for (let y = 0; y < 600; y++) {
      for (let x = 0; x < 800; x++) png.data[((y + margins.top) * png.width + x + margins.left) * 4 + 3] = 255
    }
    return PNG.sync.write(png).toString('base64')
  }

  beforeEach(() => {
    answer = (args) => {
      if (args[0] === 'session') return defaultAnswer(args)
      const command = commandOf(args)
      if (command === 'screenshot') return ok('screenshot', { data: capture(), format: 'png', width: 1024, height: 828 })
      if (command === 'list-windows') return ok('list-windows', [{ id: 'w-5', app_name: 'Safari', bounds }])
      if (command === 'list-displays') return ok('list-displays', [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scale: 2 }])
      return defaultAnswer(args)
    }
  })

  it('returns the window without its shadow, and says which screen points it shows', async () => {
    const result = await executeComputerUseCommand('screenshot', { app: 'Safari' }, caller())

    const shot = JSON.parse(result.output)
    expect(shot).toMatchObject({ type: 'screenshot', media_type: 'image/png', width: 800, height: 600 })
    expect(shot.note).toBe('This image is 800×600 pixels and shows window w-5 (Safari), at screen points x 738–1138, y 30–330: the pixel (px, py) is the screen point (738 + px × 0.5, 30 + py × 0.5).')
    expect(PNG.sync.read(Buffer.from(shot.base64, 'base64')).width).toBe(800)
    expect(result.app).toBe('Safari')
  })

  it('reads where the window is while the capture is taken, not after it', async () => {
    let captureDone = false
    let listedDuringCapture = false
    useRun(async (args) => {
      runs.push([...args])
      if (commandOf([...args]) === 'screenshot') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        captureDone = true
      }
      if (commandOf([...args]) === 'list-windows' && !captureDone) listedDuringCapture = true
      return answer([...args])
    })

    const shot = JSON.parse((await executeComputerUseCommand('screenshot', { app: 'Safari' }, caller())).output)

    expect(listedDuringCapture).toBe(true)
    expect(shot.note).toContain('shows window w-5 (Safari)')
  })

  it('still returns the image when the window list cannot be read', async () => {
    answer = ((inner) => (args: string[]) => commandOf(args) === 'list-windows' ? 'not json' : inner(args))(answer)

    const shot = JSON.parse((await executeComputerUseCommand('screenshot', { app: 'Safari' }, caller())).output)

    expect(shot.note).toBe('This image is 1024×828 pixels; where it is on screen is not known (the window list could not be read).')
  })

  it('places a display capture on its display', async () => {
    answer = ((inner) => (args: string[]) => commandOf(args) === 'screenshot'
      ? ok('screenshot', { data: PNG.sync.write(new PNG({ width: 512, height: 288, fill: true })).toString('base64'), format: 'png' })
      : inner(args))(answer)

    const shot = JSON.parse((await executeComputerUseCommand('screenshot', { screen: 0 }, caller())).output)

    expect(shot.note).toMatch(/shows display 0, at screen points x 0–2560, y 0–1440: the pixel \(px, py\) is the screen point \(0 \+ px × 5, 0 \+ py × 5\)/)
  })

  it('hands back the envelope when a screenshot cannot be read as an image, without its base64', async () => {
    const unreadable = Buffer.from('not a png '.repeat(500)).toString('base64')
    answer = (args) => args[0] === 'session'
      ? defaultAnswer(args)
      : ok(commandOf(args), commandOf(args) === 'screenshot' ? { data: unreadable, format: 'png' } : [])

    const result = await executeComputerUseCommand('screenshot', { app: 'Finder' }, caller())

    expect(JSON.parse(result.output)).toMatchObject({ ok: true, command: 'screenshot', data: { format: 'png' } })
    expect(JSON.parse(result.output).data.data).toMatch(/^\[image left out: \d+ characters of base64/)
  })

  it('reads the display and window lists for a screenshot within a short limit', async () => {
    const limits: Array<number | undefined> = []
    useRun(async (args, options) => {
      runs.push([...args])
      if (args[0] === 'list-windows' || args[0] === 'list-displays') limits.push(options?.timeoutMs)
      return answer([...args])
    })

    await executeComputerUseCommand('screenshot', { app: 'Safari' }, caller())
    await executeComputerUseCommand('screenshot', { screen: 0 }, caller())

    expect(limits).toEqual([2000, 2000])
  })
})

describe('what a call acts on', () => {
  it('reads a snapshot that names no app from the focused app, and pins it there', async () => {
    answer = (args) => commandOf(args) === 'list-windows'
      ? ok('list-windows', [{ id: 'w-1', app_name: 'Notes', is_focused: false }, { id: 'w-2', app_name: 'Mail', is_focused: true }])
      : defaultAnswer(args)

    expect(await resolveComputerUseTargetApp('snapshot', {})).toBe('Mail')
    await executeComputerUseCommand('snapshot', {}, caller())

    expect(runs.find((args) => commandOf(args) === 'snapshot')).toEqual(['--session', 'ads-1', 'snapshot', '--app=Mail'])
  })

  it('places a point in the focused window when it covers it, it being on top', async () => {
    answer = (args) => commandOf(args) === 'list-windows'
      ? ok('list-windows', [
        { id: 'w-1', app_name: 'Safari', bounds: { x: 313, y: 46, width: 1790, height: 1246 }, visible: true },
        { id: 'w-2', app_name: 'Spotify', bounds: { x: 85, y: 196, width: 1712, height: 993 }, visible: true, is_focused: true },
      ])
      : defaultAnswer(args)

    expect(await resolveComputerUseTargetApp('mouse-click', { xy: '980,977', headed: true })).toBe('Spotify')
    expect(await resolveComputerUseTargetApp('mouse-click', { xy: '2000,1000' })).toBe('Safari')
  })

  it('places a point in the one app whose shown windows cover it, and input at any other point nowhere', async () => {
    answer = (args) => commandOf(args) === 'list-windows'
      ? ok('list-windows', [
        { id: 'w-1', app_name: 'Notes', bounds: { x: 0, y: 0, width: 500, height: 500 } },
        { id: 'w-2', app_name: 'Mail', bounds: { x: 400, y: 0, width: 500, height: 500 } },
        { id: 'w-3', app_name: 'Maps', bounds: { x: 0, y: 0, width: 2560, height: 30 }, visible: false },
      ])
      : defaultAnswer(args)

    expect(await resolveComputerUseTargetApp('mouse-click', { argv: ['--xy=100,10'] })).toBe('Notes')
    // Two apps' windows, or none: no app's grant covers a click there (an
    // "Entire screen" grant for screenshots does not), so the user is asked.
    expect(await resolveComputerUseTargetApp('mouse-click', { argv: ['--xy=450,100'] })).toBeUndefined()
    expect(await resolveComputerUseTargetApp('mouse-click', { argv: ['--xy=2000,100'] })).toBeUndefined()
    // A drag that starts in Notes and ends on no app's window is not Notes' alone.
    expect(await resolveComputerUseTargetApp('drag', { argv: ['--from-xy=100,10', '--to-xy=2000,100', '--headed'] })).toBeUndefined()
    expect(await resolveComputerUseTargetApp('mouse-wheel', { argv: ['--x=100', '--y=10'] })).toBe('Notes')
  })

  it('reads a shell surface without pinning it to the focused app', async () => {
    await executeComputerUseCommand('snapshot', { surface: 'dock' }, caller())

    expect(runs.find((args) => commandOf(args) === 'snapshot')).toEqual(['--session', 'ads-1', 'snapshot', '--surface=dock'])
    expect(runs.some((args) => commandOf(args) === 'list-windows')).toBe(false)
    expect(await resolveComputerUseTargetApp('snapshot', { surface: 'dock' })).toBe('Entire screen')
  })

  it('refuses to act in this app\'s own windows', async () => {
    answer = (args) => commandOf(args) === 'list-windows'
      ? ok('list-windows', [{ id: 'w-0', app_name: 'Gamut', is_focused: true, pid: process.pid, bounds: { x: 0, y: 0, width: 800, height: 600 } }])
      : defaultAnswer(args)

    expect(await resolveComputerUseTargetApp('snapshot', {})).toBeUndefined()
    await expect(executeComputerUseCommand('snapshot', {}, caller())).rejects.toThrow(/this app's own window/)
    await expect(executeComputerUseCommand('mouse-click', { xy: '10,10', headed: true }, caller())).rejects.toThrow(/this app's own window/)
    expect(runs.some((args) => ['snapshot', 'mouse-click'].includes(commandOf(args)))).toBe(false)
  })

  it('names the clipboard as its own target', async () => {
    expect(await resolveComputerUseTargetApp('run', { args: ['clipboard-get'] })).toBe('Clipboard')
  })

  it('learns the snapshots a batch took', async () => {
    answer = (args) => commandOf(args) === 'batch'
      ? ok('batch', { results: [{ command: 'snapshot', ok: true, data: { app: 'Notes', snapshot_id: 'snapBatch', tree: {} } }] })
      : defaultAnswer(args)

    await executeComputerUseCommand('run', { args: ['batch', JSON.stringify([{ command: 'snapshot', args: { app: 'Notes' } }])] }, caller())

    expect(await resolveComputerUseTargetApp('click', { ref: '@snapBatch:e1' })).toBe('Notes')
  })

  it('names the app from the call, a known snapshot, or the window list', async () => {
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())

    expect(await resolveComputerUseTargetApp('launch', { app: 'Calculator' })).toBe('Calculator')
    expect(await resolveComputerUseTargetApp('click', { ref: '@snapA:e1' })).toBe('Finder')
    expect(await resolveComputerUseTargetApp('run', { args: ['double-click', '@snapA:e3'] })).toBe('Finder')
    expect(await resolveComputerUseTargetApp('press', { combo: 'x', window_id: 'w-7' })).toBe('Notes')
    expect(await resolveComputerUseTargetApp('click', { ref: '@unknown:e1' })).toBeUndefined()
  })
})

describe('executeComputerUseCommand ordering', () => {
  it('runs one session\'s commands one at a time, in the order they arrive', async () => {
    const order: string[] = []
    const gates: Array<() => void> = []
    useRun(async (args) => {
      runs.push([...args])
      if (commandOf([...args]) !== 'click') return answer([...args])
      order.push(`start ${args.at(-1)}`)
      await new Promise<void>((resolve) => gates.push(resolve))
      order.push(`end ${args.at(-1)}`)
      return answer([...args])
    })

    const calls = ['@s1:e1', '@s1:e2', '@s1:e3'].map((ref) => executeComputerUseCommand('click', { ref }, caller()))
    // Only the first has started; each starts when the one before it ends.
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(gates).toHaveLength(i + 1))
      gates[i]()
    }
    await Promise.all(calls)
    expect(order).toEqual(['start @s1:e1', 'end @s1:e1', 'start @s1:e2', 'end @s1:e2', 'start @s1:e3', 'end @s1:e3'])
  })

  it('keeps going after a command in the queue fails', async () => {
    await expect(executeComputerUseCommand('run', { args: ['session', 'list'] }, caller())).rejects.toThrow()
    const result = await executeComputerUseCommand('click', { ref: '@snapA:e1' }, caller())
    expect(JSON.parse(result.output).ok).toBe(true)
  })
})

describe('endComputerUseSessions', () => {
  it('ends only the matching agent\'s sessions', async () => {
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller('session-1'))
    await executeComputerUseCommand('snapshot', { app: 'Finder' }, { ...caller('session-2'), agentSlug: 'agent-b' })
    runs.length = 0

    await endComputerUseSessions({ agentSlug: 'agent-a' })

    expect(runs).toEqual([['session', 'end', 'ads-1']])
  })
})

describe('a command that stops without its result', () => {
  it('answers an action as a failure whose delivery is unknown, and a read as safe to repeat', async () => {
    answer = (args) => (['set-value', 'snapshot'].includes(commandOf(args)) ? 'thread main panicked at src/text.rs:42' : defaultAnswer(args))

    const action = JSON.parse((await executeComputerUseCommand('set-value', { ref: '@snapA:e1', value: '東京 🗼' }, caller())).output)
    expect(action).toMatchObject({ ok: false, error: { code: 'INTERNAL', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } } })
    expect(action.error.message).toContain('panicked')

    const read = JSON.parse((await executeComputerUseCommand('snapshot', { app: 'Finder' }, caller())).output)
    expect(read).toMatchObject({ ok: false, error: { code: 'INTERNAL', disposition: { retry: 'safe' } } })
  })

  it('leaves help as the text it is', async () => {
    answer = (args) => (args.includes('--help') ? 'Usage: agent-desktop click [OPTIONS] <REF>' : defaultAnswer(args))
    expect((await executeComputerUseCommand('run', { args: ['click', '--help'] }, caller())).output).toBe('Usage: agent-desktop click [OPTIONS] <REF>')
  })
})

describe('placing a call that names no app', () => {
  it('judges keys sent to no app as sent to the focused app', async () => {
    answer = (args) => (args[0] === 'list-windows'
      ? ok('list-windows', [{ id: 'w-3', title: 'Doc', app_name: 'TextEdit', pid: 5, is_focused: true }])
      : defaultAnswer(args))
    expect(await resolveComputerUseTargetApp('press', { combo: 'cmd+s' })).toBe('TextEdit')
  })
})

describe('an app named two ways on Windows', () => {
  const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
  afterEach(() => { Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM) })
  const notepadWindow = (args: string[]) => (commandOf(args) === 'list-windows'
    ? ok('list-windows', [{ id: 'w-61', title: 'Untitled - Notepad', app_name: 'Notepad.exe', pid: 9, is_focused: true }])
    : defaultAnswer(args))

  it('is one app under its launch name and its image name', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    answer = notepadWindow
    expect(await resolveComputerUseTargetApp('press', { combo: 'ctrl+shift+s', app: 'notepad', window_id: 'w-61' })).toBe('notepad')
    await executeComputerUseCommand('press', { combo: 'ctrl+shift+s', app: 'notepad', window_id: 'w-61' }, caller())
    await executeComputerUseCommand('snapshot', { app: 'Notepad.exe' }, caller(), { app: 'notepad' })
    expect(runs.filter((args) => ['press', 'snapshot'].includes(commandOf(args)))).toHaveLength(2)
  })

  it('stays two apps on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    answer = notepadWindow
    await expect(executeComputerUseCommand('press', { combo: 'cmd+s', app: 'notepad', window_id: 'w-61' }, caller()))
      .rejects.toThrow(/One call acts in one app; this one names notepad, Notepad\.exe/)
  })
})

describe('a Store app on Windows', () => {
  const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => { activated.length = 0 })
  afterEach(() => { Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM) })
  const notFound = (command: string): AgentDesktopEnvelope => ({ version: '2.6', ok: false, command, error: { code: 'APP_NOT_FOUND', message: 'not found' } })

  it('launches by its Start menu name when agent-desktop knows no such executable, answering with its window', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    let listed = 0
    answer = (args) => {
      const command = commandOf(args)
      if (command === 'launch') return notFound('launch')
      if (command === 'list-windows') {
        return ok('list-windows', listed++ === 0 ? [] : [{ id: 'w-calc', title: 'Calculator', app_name: 'CalculatorApp.exe', pid: 8 }])
      }
      return defaultAnswer(args)
    }
    const result = await executeComputerUseCommand('launch', { app: 'Calculator', activate: true }, caller())
    expect(activated).toEqual(['Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'])
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, command: 'launch', data: { app: 'CalculatorApp.exe', window: { id: 'w-calc' }, start_menu: { name: 'Calculator' } } })
  })

  it('leaves a name the Start menu does not have, and every launch off Windows, as agent-desktop answered', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    answer = (args) => (commandOf(args) === 'launch' ? notFound('launch') : defaultAnswer(args))
    expect(JSON.parse((await executeComputerUseCommand('launch', { app: 'Calc' }, caller())).output)).toMatchObject({ ok: false })
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(JSON.parse((await executeComputerUseCommand('launch', { app: 'Calculator' }, caller())).output)).toMatchObject({ ok: false })
    expect(activated).toEqual([])
  })

  it('captures by its window when agent-desktop cannot capture it by name', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    answer = (args) => {
      const command = commandOf(args)
      if (command === 'screenshot') return args.some((token) => token.startsWith('--window-id=')) ? ok('screenshot', { data: 'not-a-png' }) : notFound('screenshot')
      if (command === 'list-windows') return ok('list-windows', [{ id: 'w-calc', title: 'Calculator', app_name: 'CalculatorApp.exe', pid: 8 }])
      return defaultAnswer(args)
    }
    await executeComputerUseCommand('screenshot', { app: 'CalculatorApp.exe' }, caller())
    const shots = runs.filter((args) => commandOf(args) === 'screenshot')
    expect(shots).toHaveLength(2)
    expect(shots[1]).toContain('--window-id=w-calc')
    expect(shots[1].some((token) => token.startsWith('--app'))).toBe(false)
  })
})

describe('running an approved call', () => {
  const focusedOn = (app: string, pid = 5) => (args: string[]) => (commandOf(args) === 'list-windows'
    ? ok('list-windows', [{ id: 'w-3', app_name: app, pid, is_focused: true, bounds: { x: 0, y: 0, width: 1000, height: 800 } }])
    : defaultAnswer(args))

  it('runs only in the app it was approved for', async () => {
    await expect(executeComputerUseCommand('snapshot', { app: 'Notes' }, caller(), { app: 'Finder' }))
      .rejects.toThrow(/names Notes, but it was approved for Finder\. Nothing was sent/)
    await expect(executeComputerUseCommand('run', { args: ['clipboard-get'] }, caller(), { app: 'Safari' }))
      .rejects.toThrow(/names Clipboard, but it was approved for Safari/)
    expect(runs.some((args) => ['snapshot', 'clipboard-get'].includes(commandOf(args)))).toBe(false)
  })

  it('sends keys meant for the focused app only while that app still has focus', async () => {
    // Approving the call in this app's window brought this app forward.
    answer = focusedOn('Gamut', process.pid)
    await expect(executeComputerUseCommand('press', { combo: 'return' }, caller(), { app: 'Notes' }))
      .rejects.toThrow(/The focused app is now this app; this press was approved for Notes\. Nothing was sent\. Pass app "Notes"/)
    answer = focusedOn('TextEdit')
    await expect(executeComputerUseCommand('press', { combo: 'return' }, caller(), { app: 'Notes' }))
      .rejects.toThrow(/focused app is now TextEdit/)
    expect(runs.some((args) => commandOf(args) === 'press')).toBe(false)

    answer = focusedOn('Notes')
    await executeComputerUseCommand('press', { combo: 'return' }, caller(), { app: 'Notes' })
    expect(runs.find((args) => commandOf(args) === 'press')).toEqual(['--session', 'ads-1', 'press', '--', 'return'])
  })

  it('acts at a point only while the approved app\'s window is still there', async () => {
    answer = focusedOn('Mail')
    await expect(executeComputerUseCommand('mouse-click', { xy: '10,10', headed: true }, caller(), { app: 'Safari' }))
      .rejects.toThrow(/The window at that point is now Mail's; this mouse-click was approved for Safari/)
    answer = focusedOn('Safari')
    await executeComputerUseCommand('mouse-click', { xy: '10,10', headed: true }, caller(), { app: 'Safari' })
    expect(runs.some((args) => commandOf(args) === 'mouse-click')).toBe(true)
  })

  it('leaves the approval standing when the window list cannot tell', async () => {
    answer = (args) => (commandOf(args) === 'list-windows' ? 'not json' : defaultAnswer(args))
    await executeComputerUseCommand('press', { combo: 'return' }, caller(), { app: 'Notes' })
    expect(runs.some((args) => commandOf(args) === 'press')).toBe(true)
  })
})

describe('time and size', () => {
  it('gives a wait for a duration that long, written either way', async () => {
    const timeouts: Array<number | undefined> = []
    useRun(async (args, options) => {
      runs.push([...args])
      if (commandOf([...args]) === 'wait') timeouts.push(options?.timeoutMs)
      return answer([...args])
    })

    await executeComputerUseCommand('wait', { ms: 120_000 }, caller())
    await executeComputerUseCommand('run', { args: ['wait', '120000'] }, caller())

    expect(runs.filter((args) => commandOf(args) === 'wait').map((args) => args.slice(2))).toEqual([['wait', '--', '120000'], ['wait', '120000']])
    expect(timeouts.every((ms) => (ms ?? 0) > 120_000)).toBe(true)
  })

  it('reads the window list for placing a call within a short limit', async () => {
    const limits: Array<number | undefined> = []
    useRun(async (args, options) => {
      runs.push([...args])
      if (args[0] === 'list-windows') limits.push(options?.timeoutMs)
      return answer([...args])
    })

    await resolveComputerUseTargetApp('press', { combo: 'x', window_id: 'w-unknown' })
    await resolveComputerUseTargetApp('mouse-click', { xy: '1,1' })

    expect(limits.length).toBeGreaterThan(0)
    expect(limits.every((ms) => ms === 2000)).toBe(true)
  })

  it('leaves a screenshot\'s base64 out of a batch\'s text result', async () => {
    const image = 'A'.repeat(4000)
    answer = (args) => commandOf(args) === 'batch'
      ? ok('batch', { results: [{ command: 'screenshot', ok: true, data: { data: image, format: 'png' } }, { command: 'wait', ok: true, data: { waited_ms: 10 } }] })
      : defaultAnswer(args)

    const result = await executeComputerUseCommand('run', { args: ['batch', JSON.stringify([{ command: 'screenshot', args: { app: 'Safari' } }, { command: 'wait', args: { ms: 10 } }])] }, caller())

    expect(result.output).not.toContain(image)
    const results = JSON.parse(result.output).data.results
    expect(results[0].data.data).toMatch(/^\[image left out: 4000 characters of base64/)
    expect(results[1].data).toEqual({ waited_ms: 10 })
  })
})

describe('ending a session\'s computer use', () => {
  it('stops its running command and drops the ones queued before, but runs later ones', async () => {
    const { AgentDesktopAbortedError } = await vi.importActual<typeof import('./agent-desktop')>('./agent-desktop')
    useRun(async (args, options) => {
      runs.push([...args])
      if (commandOf([...args]) !== 'wait') return answer([...args])
      return new Promise<Answer>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new AgentDesktopAbortedError('wait')))
      })
    })

    const waiting = executeComputerUseCommand('wait', { ms: 60_000 }, caller())
    const queued = executeComputerUseCommand('click', { ref: '@snapA:e1' }, caller())
    await vi.waitFor(() => expect(runs.some((args) => commandOf(args) === 'wait')).toBe(true))
    await endComputerUseSessions({ sessionId: 'session-1' })

    expect(JSON.parse((await waiting).output)).toMatchObject({ ok: false, error: { code: 'CANCELLED', disposition: { retry: 'safe' } } })
    await expect(queued).rejects.toThrow(/was ended .*before its turn\. Nothing was done/)
    expect(runs.some((args) => commandOf(args) === 'click')).toBe(false)

    await executeComputerUseCommand('click', { ref: '@snapA:e1' }, caller())
    expect(runs.some((args) => commandOf(args) === 'click')).toBe(true)
  })
})

describe('resolveComputerUseTargetApp and remembered windows', () => {
  it('asks again when a remembered window id now belongs to another app', async () => {
    answer = (args) => (args[0] === 'list-windows'
      ? ok('list-windows', [{ id: 'w-77', title: 'Notes', app_name: 'Notes', pid: 4 }])
      : defaultAnswer(args))
    expect(await resolveComputerUseTargetApp('screenshot', { argv: ['--window-id=w-77'] })).toBe('Notes')

    // The id is reused: Notes's window is gone and Preview's took its number.
    answer = (args) => (args[0] === 'list-windows'
      ? ok('list-windows', [{ id: 'w-77', title: 'photo.jpg', app_name: 'Preview', pid: 9 }])
      : defaultAnswer(args))
    expect(await resolveComputerUseTargetApp('screenshot', { argv: ['--app=Preview', '--window-id=w-77'] })).toBe('Preview')
  })
})

describe('checkComputerUsePermissions', () => {
  it('needs Accessibility for every call and Screen Recording for a screenshot, and believes a grant until a command is refused for want of one', async () => {
    answer = () => ok('permissions', { accessibility: { state: 'granted' }, screen_recording: { state: 'denied' } })
    expect(await checkComputerUsePermissions()).toBeNull()
    expect(await checkComputerUsePermissions({ screenRecording: true })).toEqual({ accessibility: true, screen_recording: false })

    // Checked before every command, so a grant is not re-read each time...
    answer = (args) => (args[0] === 'permissions'
      ? ok('permissions', { accessibility: { state: 'denied' }, screen_recording: { state: 'granted' } })
      : defaultAnswer(args))
    const checks = runs.filter((args) => args[0] === 'permissions').length
    expect(await checkComputerUsePermissions()).toBeNull()
    expect(runs.filter((args) => args[0] === 'permissions')).toHaveLength(checks)

    // ...until a command reports it lacks one, which goes to the user, not the agent.
    const refuse = answer
    answer = (args) => (commandOf(args) === 'click'
      ? { version: '2.6', ok: false, command: 'click', error: { code: 'PERM_DENIED', message: 'Accessibility permission not granted' } }
      : refuse(args))
    expect(await executeComputerUseCommand('click', { ref: '@snapA:e1' }, caller())).toMatchObject({ permissionDenied: true })
    expect(await checkComputerUsePermissions()).toEqual({ accessibility: false, screen_recording: true })
  })
})

describe('cursorLabel', () => {
  it('is the agent\'s name, cut to its first six words', () => {
    expect(cursorLabel('Invoice Bot')).toBe('Invoice Bot')
    expect(cursorLabel('  The   very long name of this little agent  ')).toBe('The very long name of this')
  })
})
