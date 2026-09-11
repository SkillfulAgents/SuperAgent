import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listAccounts,
  listLoginItems,
  opProcess,
  readLoginFields,
} from './op-client'

function fakeChild(opts: {
  pid?: number
  stdout?: string
  stderr?: string
  code?: number | null
  error?: NodeJS.ErrnoException
  hang?: boolean
} = {}) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn> }
    unref: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }
  child.pid = opts.pid ?? 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  child.unref = vi.fn()
  child.kill = vi.fn()

  if (!opts.hang) {
    queueMicrotask(() => {
      if (opts.error) {
        child.emit('error', opts.error)
        return
      }
      if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout))
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr))
      child.emit('close', opts.code ?? 0)
    })
  }
  return child
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('op-client', () => {
  it('pins OP_FORMAT=json and OP_ACCOUNT on vault-touching spawns', async () => {
    const child = fakeChild({ stdout: '[]' })
    const spawn = vi.spyOn(opProcess, 'spawn').mockReturnValue(child as never)
    await listLoginItems('A1B2C3')
    expect(spawn).toHaveBeenCalled()
    const options = spawn.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }
    expect(options.env?.OP_FORMAT).toBe('json')
    expect(options.env?.OP_ACCOUNT).toBe('A1B2C3')
  })

  it('lists login summaries as a direct op spawn', async () => {
    const child = fakeChild({ stdout: '[]' })
    const spawn = vi.spyOn(opProcess, 'spawn').mockReturnValue(child as never)
    await listLoginItems('A1B2C3')
    expect(spawn.mock.calls[0][0]).toBe('op')
    expect(spawn.mock.calls[0][1]).toEqual(['item', 'list', '--categories', 'Login', '--format', 'json'])
    expect((spawn.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }).env?.OP_ACCOUNT).toBe('A1B2C3')
  })

  it('does not set OP_ACCOUNT on account enumeration', async () => {
    const previous = {
      OP_ACCOUNT: process.env.OP_ACCOUNT,
      OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN,
      OP_CONNECT_HOST: process.env.OP_CONNECT_HOST,
      OP_CONNECT_TOKEN: process.env.OP_CONNECT_TOKEN,
    }
    process.env.OP_ACCOUNT = 'AMBIENT'
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_ambient'
    process.env.OP_CONNECT_HOST = 'https://connect.example'
    process.env.OP_CONNECT_TOKEN = 'connect_ambient'
    try {
      const child = fakeChild({ stdout: '[]' })
      const spawn = vi.spyOn(opProcess, 'spawn').mockReturnValue(child as never)
      await listAccounts()
      const options = spawn.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }
      expect(options.env?.OP_FORMAT).toBe('json')
      expect(options.env?.OP_ACCOUNT).toBeUndefined()
      expect(options.env?.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined()
      expect(options.env?.OP_CONNECT_HOST).toBeUndefined()
      expect(options.env?.OP_CONNECT_TOKEN).toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('classifies ENOENT as not_installed', async () => {
    const error = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })
    vi.spyOn(opProcess, 'spawn').mockReturnValue(fakeChild({ error }) as never)
    await expect(listAccounts()).rejects.toMatchObject({ code: 'not_installed' })
  })

  it('classifies "no account found"-style stderr as not_signed_in', async () => {
    // pinned against op <version> during smoke
    vi.spyOn(opProcess, 'spawn').mockReturnValue(fakeChild({
      code: 1,
      stderr: '[ERROR] no account found for filter',
    }) as never)
    await expect(listAccounts()).rejects.toMatchObject({ code: 'not_signed_in' })
  })

  it('classifies connection-refused/integration stderr as cli_integration_off', async () => {
    // pinned against op <version> during smoke
    vi.spyOn(opProcess, 'spawn').mockReturnValue(fakeChild({
      code: 1,
      stderr: "connecting to desktop app: connection refused",
    }) as never)
    await expect(listAccounts()).rejects.toMatchObject({ code: 'cli_integration_off' })
  })

  it('classifies user-canceled authorization as unlock_denied', async () => {
    // pinned against op <version> during smoke
    vi.spyOn(opProcess, 'spawn').mockReturnValue(fakeChild({
      code: 1,
      stderr: '[ERROR] authorization prompt was dismissed',
    }) as never)
    await expect(listAccounts()).rejects.toMatchObject({ code: 'unlock_denied' })
  })

  it('rejects with timeout code and kills the child, not a process group', async () => {
    vi.useFakeTimers()
    const child = fakeChild({ hang: true, pid: 99 })
    vi.spyOn(opProcess, 'spawn').mockReturnValue(child as never)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)

    const pending = expect(listAccounts()).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(15_000)
    await pending
    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('readLoginFields fails with item_unreadable when username is missing', async () => {
    vi.spyOn(opProcess, 'spawn').mockReturnValue(fakeChild({
      stdout: JSON.stringify([{ id: 'password', label: 'password', value: 'x' }]),
    }) as never)
    await expect(readLoginFields('item-1', 'A1B2C3')).rejects.toMatchObject({
      code: 'item_unreadable',
      message: 'The selected login has no username',
    })
  })

  it('readLoginFields fails with item_unreadable when password is missing', async () => {
    vi.spyOn(opProcess, 'spawn').mockReturnValue(fakeChild({
      stdout: JSON.stringify([{ id: 'username', label: 'username', value: 'a' }]),
    }) as never)
    await expect(readLoginFields('item-1', 'A1B2C3')).rejects.toMatchObject({
      code: 'item_unreadable',
    })
  })

  it('never resolves with trimmed values', async () => {
    vi.spyOn(opProcess, 'spawn').mockReturnValue(fakeChild({
      stdout: JSON.stringify([
        { id: 'username', label: 'username', value: '  user  ' },
        { id: 'password', label: 'password', value: ' p,ass word ' },
      ]),
    }) as never)
    await expect(readLoginFields('item-1', 'A1B2C3')).resolves.toEqual({
      username: '  user  ',
      password: ' p,ass word ',
    })
  })

  it('rejects an aborted signal as timeout canceled and does not group-kill', async () => {
    const child = fakeChild({ hang: true, pid: 88 })
    vi.spyOn(opProcess, 'spawn').mockReturnValue(child as never)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const controller = new AbortController()
    const pending = expect(readLoginFields('item-1', 'A1B2C3', controller.signal)).rejects.toEqual(expect.objectContaining({
      code: 'timeout',
      message: expect.stringMatching(/canceled/i),
    }))
    controller.abort()
    await pending
    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
