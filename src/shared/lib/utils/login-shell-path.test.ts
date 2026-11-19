import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Stand-ins for the person's shell: called as `<shell> -ilc <command>`.
let dir: string
let chattyShell: string
let silentShell: string

function writeShell(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

async function freshModule() {
  vi.resetModules()
  return import('./login-shell-path')
}

function setProcessType(type: string | undefined) {
  Object.defineProperty(process, 'type', { value: type, configurable: true })
}

describe.skipIf(process.platform === 'win32')('login-shell-path', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-shell-path-'))
    // A config that prints a banner and adds a directory, like a real one.
    chattyShell = writeShell('chatty', 'echo "Welcome back"\nPATH=/from/login/shell:$PATH\nexec /bin/sh -c "$2"')
    silentShell = writeShell('silent', 'echo "no path here"')
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    vi.stubEnv('PATH', '/usr/bin:/bin')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    setProcessType(undefined)
  })

  describe('readLoginShellPath', () => {
    it('returns the PATH alone when the shell config prints to stdout', async () => {
      const { readLoginShellPath } = await freshModule()

      expect(await readLoginShellPath(chattyShell)).toBe('/from/login/shell:/usr/bin:/bin')
    })

    it('rejects when the shell prints no PATH', async () => {
      const { readLoginShellPath } = await freshModule()

      await expect(readLoginShellPath(silentShell)).rejects.toThrow('printed no PATH')
    })
  })

  describe('loginShellPath', () => {
    it('returns the process PATH outside the Electron main process', async () => {
      vi.stubEnv('SHELL', chattyShell)
      const { loginShellPath } = await freshModule()

      expect(await loginShellPath()).toBe('/usr/bin:/bin')
    })

    it('asks the shell once and keeps its answer', async () => {
      setProcessType('browser')
      vi.stubEnv('SHELL', chattyShell)
      const { loginShellPath } = await freshModule()

      expect(await loginShellPath()).toBe('/from/login/shell:/usr/bin:/bin')
      vi.stubEnv('SHELL', silentShell)
      expect(await loginShellPath()).toBe('/from/login/shell:/usr/bin:/bin')
    })

    it('falls back to common directories and asks again next time', async () => {
      setProcessType('browser')
      vi.stubEnv('SHELL', silentShell)
      const { loginShellPath } = await freshModule()

      expect(await loginShellPath()).toBe('/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin')
      vi.stubEnv('SHELL', chattyShell)
      expect(await loginShellPath()).toBe('/from/login/shell:/usr/bin:/bin')
    })
  })

  describe('withLoginShellPath', () => {
    it('replaces only PATH', async () => {
      setProcessType('browser')
      vi.stubEnv('SHELL', chattyShell)
      const { withLoginShellPath } = await freshModule()

      expect(await withLoginShellPath({ GIT_TERMINAL_PROMPT: '0', PATH: '/elsewhere' })).toEqual({
        GIT_TERMINAL_PROMPT: '0',
        PATH: '/from/login/shell:/usr/bin:/bin',
      })
    })
  })
})
