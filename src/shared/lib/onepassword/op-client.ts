import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { z } from 'zod'
import { getEnhancedPath } from '../container/base-container-client'
import {
  parseAccounts,
  parseFieldOutput,
  parseLoginItems,
  type OpAccount,
  type OpLoginItem,
} from './op-schema'

/**
 * Thin wrapper over the `op` CLI, using the user's 1Password desktop-app
 * session. Desktop-app auth is the only path that reaches Personal/Private
 * vaults — service accounts are policy-blocked from them, which is exactly
 * where website logins live.
 *
 * `readLoginFields` is the only function that returns a secret. Nothing here
 * logs a value, and no caller may pass one back across a route boundary.
 */

export type OpErrorCode =
  | 'not_installed'
  | 'not_signed_in'
  | 'cli_integration_off'
  | 'unlock_denied'
  | 'timeout'
  | 'item_unreadable'
  | 'unknown'

export class OpError extends Error {
  constructor(
    public readonly code: OpErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OpError'
  }
}

const SINGLE_TIMEOUT_MS = 15_000
const ACCOUNT_UUID = z.string().regex(/^[A-Z0-9]+$/i)

export const opProcess = {
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
    return spawn(command, args, options)
  },
}

export function spawnOp(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return opProcess.spawn(command, args, options)
}

const AMBIENT_OP_VARS = [
  'OP_ACCOUNT',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'OP_CONNECT_HOST',
  'OP_CONNECT_TOKEN',
] as const

function opEnv(accountUuid?: string): NodeJS.ProcessEnv {
  if (accountUuid !== undefined) ACCOUNT_UUID.parse(accountUuid)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: getEnhancedPath(),
    OP_FORMAT: 'json',
  }
  for (const key of AMBIENT_OP_VARS) delete env[key]
  if (accountUuid) env.OP_ACCOUNT = accountUuid
  return env
}

function killChild(child: { pid?: number | null; kill?: (signal?: NodeJS.Signals) => boolean }): void {
  if (child.pid == null) return
  try {
    child.kill?.('SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    throw error
  }
}

function classifyOpError(err: unknown, stderr: string): OpError {
  if (err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
    return new OpError('not_installed', '1Password CLI is not installed')
  }
  const text = stderr
  if (/no account found/i.test(text) || /not currently signed in/i.test(text)) {
    return new OpError('not_signed_in', text.trim() || 'Not signed in to 1Password')
  }
  if (
    /connection refused/i.test(text) ||
    /isn't connected/i.test(text) ||
    /cli integration/i.test(text)
  ) {
    return new OpError('cli_integration_off', text.trim() || '1Password CLI integration is off')
  }
  if (/authorization/i.test(text) && /dismiss|cancel|denied/i.test(text)) {
    return new OpError('unlock_denied', text.trim() || '1Password authorization was denied')
  }
  return new OpError('unknown', text.trim() || (err instanceof Error ? err.message : 'op failed'))
}

function runChild(
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new OpError('timeout', 'canceled'))
      return
    }

    const child = spawnOp(command, args, {
      env: opts.env,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      try {
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        fn()
      } finally {
        timer = undefined
      }
    }

    const onAbort = () => {
      killChild(child)
      settle(() => reject(new OpError('timeout', 'canceled')))
    }

    timer = setTimeout(() => {
      killChild(child)
      settle(() => reject(new OpError('timeout', `op timed out after ${opts.timeoutMs}ms`)))
    }, opts.timeoutMs)

    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => {
      settle(() => reject(classifyOpError(err, stderr)))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        settle(() => reject(classifyOpError(undefined, stderr)))
        return
      }
      settle(() => resolve(stdout))
    })
    child.stdin?.end()
  })
}

function runOp(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  return runChild('op', args, opts)
}

export async function listAccounts(signal?: AbortSignal): Promise<OpAccount[]> {
  const out = await runOp(['account', 'list', '--format', 'json'], {
    env: opEnv(),
    timeoutMs: SINGLE_TIMEOUT_MS,
    signal,
  })
  try {
    return parseAccounts(JSON.parse(out) as unknown)
  } catch (error) {
    if (error instanceof OpError) throw error
    throw new OpError('unknown', 'op returned invalid JSON')
  }
}

export async function listLoginItems(accountUuid: string, signal?: AbortSignal): Promise<OpLoginItem[]> {
  const out = await runOp(['item', 'list', '--categories', 'Login', '--format', 'json'], {
    env: opEnv(accountUuid),
    timeoutMs: SINGLE_TIMEOUT_MS,
    signal,
  })
  try {
    const parsed = JSON.parse(out) as unknown
    return parseLoginItems(Array.isArray(parsed) ? parsed : [])
  } catch (error) {
    if (error instanceof OpError) throw error
    throw new OpError('unknown', 'op returned invalid JSON')
  }
}

export async function readLoginFields(
  itemId: string,
  accountUuid: string,
  signal?: AbortSignal,
): Promise<{ username: string; password: string }> {
  const out = await runOp(
    ['item', 'get', itemId, '--fields', 'label=username,label=password', '--reveal', '--format', 'json'],
    { env: opEnv(accountUuid), timeoutMs: SINGLE_TIMEOUT_MS, signal },
  )
  let parsed: { username: string; password: string | null }
  try {
    parsed = parseFieldOutput(JSON.parse(out) as unknown)
  } catch (error) {
    if (error instanceof OpError) throw error
    throw new OpError('unknown', 'op returned invalid JSON')
  }
  if (!parsed.username) {
    throw new OpError('item_unreadable', 'The selected login has no username')
  }
  if (parsed.password === null) {
    throw new OpError('item_unreadable', 'The selected login has no password')
  }
  return { username: parsed.username, password: parsed.password }
}

