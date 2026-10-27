import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { clearStaleProcessSingleton } from './process-singleton'

/**
 * What a SIGKILLed launch of the App Sandbox build leaves behind, as seen on
 * hardware: the lock names the dead pid, and the fixed socket directory still
 * holds the socket and the cookie the next launch fails to create.
 */

let root: string
let userData: string
let socketDir: string

function leftovers(owner: string) {
  fs.symlinkSync(owner, path.join(userData, 'SingletonLock'))
  fs.symlinkSync(path.join(socketDir, 'SingletonSocket'), path.join(userData, 'SingletonSocket'))
  fs.symlinkSync('15461870986606705924', path.join(userData, 'SingletonCookie'))
  fs.writeFileSync(path.join(socketDir, 'SingletonSocket'), '')
  fs.symlinkSync('15461870986606705924', path.join(socketDir, 'SingletonCookie'))
}

const remaining = () => [
  ...fs.readdirSync(userData).filter((f) => f.startsWith('Singleton')),
  ...fs.readdirSync(socketDir).map((f) => `S/${f}`),
].sort()

/** process.kill(pid, 0) as the sandbox answers it. */
function signal(answer: 'ok' | 'ESRCH' | 'EPERM') {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    if (answer === 'ok') return true
    throw Object.assign(new Error(answer), { code: answer })
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-singleton-'))
  userData = path.join(root, 'SuperAgent')
  socketDir = path.join(root, 'tmp', 'S')
  fs.mkdirSync(userData)
  fs.mkdirSync(socketDir, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

it('clears a dead launch’s files, so the next one can take the lock', () => {
  leftovers(`${os.hostname()}-88333`)
  const kill = signal('ESRCH')

  expect(clearStaleProcessSingleton(userData)).toBe(true)
  expect(kill).toHaveBeenCalledWith(88333, 0)
  expect(remaining()).toEqual([])
})

describe('leaves them alone', () => {
  it.each([
    ['for a launch of this process tree that is running', 'ok'],
    ['for one the sandbox won’t let us signal, which may be another live launch', 'EPERM'],
  ] as const)('%s', (_, answer) => {
    leftovers(`${os.hostname()}-88333`)
    signal(answer)

    expect(clearStaleProcessSingleton(userData)).toBe(false)
    expect(remaining()).toEqual(['S/SingletonCookie', 'S/SingletonSocket', 'SingletonCookie', 'SingletonLock', 'SingletonSocket'])
  })

  it.each([
    ['names another computer', 'other-host.local-88333'],
    ['names no pid', `${os.hostname()}-`],
    ['is not a lock Chromium writes', 'garbage'],
  ])('when the lock %s', (_, owner) => {
    leftovers(owner)
    const kill = signal('ESRCH')

    expect(clearStaleProcessSingleton(userData)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    expect(remaining()).toHaveLength(5)
  })

  it('when there is no lock: nothing ran, or it quit cleanly', () => {
    const kill = signal('ESRCH')
    expect(clearStaleProcessSingleton(userData)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})

it('reads hostnames that contain a dash', () => {
  vi.spyOn(os, 'hostname').mockReturnValue('Iddos-MacBook-Pro.local')
  leftovers('Iddos-MacBook-Pro.local-4242')
  const kill = signal('ESRCH')

  expect(clearStaleProcessSingleton(userData)).toBe(true)
  expect(kill).toHaveBeenCalledWith(4242, 0)
})
