/**
 * Login-shell PATH
 *
 * A desktop app started from Finder/Dock gets launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so tools the person installed with Homebrew
 * and the like (`gh` above all) aren't found. Their login shell knows the real
 * PATH, but asking it sources their whole zsh/bash config, which takes 1.5–2 s,
 * so it is asked on first use by the few callers that need it, never at launch.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Brackets the PATH in the shell's output, so whatever the person's config
// prints to stdout (banners, conda notices) is not mistaken for it.
const MARKER = '__LOGIN_SHELL_PATH__'
const PROBE_TIMEOUT_MS = 10_000
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']

let resolved: Promise<string> | null = null

/** Asks `shell` for the PATH of an interactive login session. */
export async function readLoginShellPath(shell: string): Promise<string> {
  const { stdout } = await execFileAsync(shell, ['-ilc', `printf '%s%s%s' ${MARKER} "$PATH" ${MARKER}`], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    // Interactive zsh and bash ignore SIGTERM, the default, so a hung config
    // would outlive the timeout.
    killSignal: 'SIGKILL',
    env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
  })
  const parts = stdout.split(MARKER)
  const shellPath = parts.length >= 3 ? parts[1].trim() : ''
  if (!shellPath) throw new Error(`${shell} printed no PATH`)
  return shellPath
}

/**
 * The person's login-shell PATH in the Electron main process on macOS/Linux,
 * asked once per run; elsewhere the process PATH, which already is the
 * person's (a terminal, a server, Windows).
 */
export function loginShellPath(): Promise<string> {
  const current = process.env.PATH ?? ''
  if (process.type !== 'browser' || process.platform === 'win32') return Promise.resolve(current)
  resolved ??= readLoginShellPath(process.env.SHELL || '/bin/zsh').catch(() => {
    // Not kept: a config that timed out once may answer next time.
    resolved = null
    return [...FALLBACK_DIRS.filter((dir) => !current.includes(dir)), current].join(':')
  })
  return resolved
}

/** `environment` with its PATH replaced by the login-shell PATH. */
export async function withLoginShellPath(environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  return { ...environment, PATH: await loginShellPath() }
}
