/**
 * Running the agent-desktop CLI on this machine.
 *
 * One process per command: the CLI keeps its own state (sessions, snapshot
 * refmaps) under `AGENT_DESKTOP_HOME`, so no daemon of ours sits between
 * calls. A command prints one JSON envelope, parsed here at the boundary, or
 * text (`--help`), which is kept as printed.
 *
 * The executable must be named `agent-desktop`: the macOS cursor overlay is a
 * child the CLI starts by re-running itself, and it starts none from a binary
 * by another name. A packaged app ships it that way under
 * `Resources/agent-desktop/` (see package.json `extraResources`); in
 * development the package's postinstall links `bin/agent-desktop` to the
 * native binary for this machine (on Windows it keeps only the arch-named
 * `.exe`, behind a `.cmd` launcher).
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import { createRequire } from 'module'
import * as path from 'path'
import { z } from 'zod'
import { getDataDir } from '@shared/lib/config/data-dir'

const MACOS_HELPER_NAME = 'agent-desktop-macos-helper'

/** The least time one command gets before it is stopped: `wait` defaults to 30s. */
export const COMMAND_TIMEOUT_MS = 45_000

/** The most: a command may ask agent-desktop for a long wait, but not for longer than this. */
export const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000

/** Time past a command's own budget for agent-desktop to start, settle and answer. */
const COMMAND_TIMEOUT_MARGIN_MS = 15_000

/** A command agent-desktop did not answer in time, stopped by the app. */
export class AgentDesktopTimeoutError extends Error {
  constructor(command: string, readonly timeoutMs: number) {
    super(`agent-desktop ${command} gave no result within ${timeoutMs / 1000}s`)
  }
}

/** A command the app stopped before it answered (its session's computer use ended). */
export class AgentDesktopAbortedError extends Error {
  constructor(command: string) {
    super(`agent-desktop ${command} was stopped by the app`)
  }
}

function numericFlag(args: readonly string[], name: string): number | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    const raw = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : token === name ? args[i + 1] : undefined
    if (raw === undefined) continue
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/**
 * How long a command (its arguments, from the command name on) may run
 * before it is stopped: the budget agent-desktop itself gives it, from its
 * flags and defaults, plus a margin; never less than COMMAND_TIMEOUT_MS nor
 * more than MAX_COMMAND_TIMEOUT_MS. A fixed limit below agent-desktop's own
 * would stop a long `type` or `wait` midway, with its delivery unknown.
 */
export function commandTimeoutMs(commandArgs: readonly string[]): number {
  const [command, ...args] = commandArgs
  const separator = args.indexOf('--')
  const flags = separator === -1 ? args : args.slice(0, separator)
  const timeoutMs = numericFlag(flags, '--timeout-ms')
  const timeout = numericFlag(flags, '--timeout')
  let budget: number
  if (command === 'type') {
    const typed = separator === -1 ? (args.at(-1) ?? '') : args.slice(separator + 1).join(' ')
    // One keystroke every --interval-ms adds that pause per character.
    budget = (timeoutMs ?? 5000 + 30 * typed.length) + (numericFlag(flags, '--interval-ms') ?? 0) * typed.length
  } else if (command === 'batch') {
    budget = timeoutMs ?? 60_000
  } else if (command === 'wait') {
    // `wait 5000`, or `wait -- 5000` as the generated tool writes it.
    const duration = [...flags, ...(separator === -1 ? [] : args.slice(separator + 1))].find((token) => /^\d+$/.test(token))
    budget = timeout ?? (duration !== undefined ? Number(duration) : 30_000)
  } else if (command === 'launch') {
    budget = timeout ?? 30_000
  } else {
    budget = timeoutMs ?? timeout ?? 5000
  }
  if (flags.some((token) => /^(--wait-for|--wait-for-gone|-w)(=|$)/.test(token))) {
    budget += numericFlag(flags, '--wait-timeout') ?? 30_000
  }
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(COMMAND_TIMEOUT_MS, budget + COMMAND_TIMEOUT_MARGIN_MS))
}

/** Screenshots come back inline as base64, so a call's output can be large. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export interface AgentDesktopBinary {
  executable: string
  /** The macOS helper the CLI uses for a few system calls; it must come from the same release. */
  macosHelper?: string
}

let resolved: AgentDesktopBinary | null = null

function executableName(): string {
  return process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop'
}

function fromDirectory(dir: string, helperName: string, name = executableName()): AgentDesktopBinary | null {
  const executable = path.join(dir, name)
  if (!fs.existsSync(executable)) return null
  const helper = path.join(dir, helperName)
  return {
    executable,
    ...(process.platform === 'darwin' && fs.existsSync(helper) && { macosHelper: helper }),
  }
}

/**
 * Where agent-desktop lives: the app bundle's copy when packaged, else the npm
 * package's. Outside a packaged app, `SUPERAGENT_AGENT_DESKTOP` names another
 * executable that takes the same command lines, for a test setup that runs the
 * commands on another machine (Electron main publishes `SUPERAGENT_IS_PACKAGED`
 * before anything runs; a web server run from source has none).
 */
export function resolveAgentDesktopBinary(): AgentDesktopBinary {
  if (resolved) return resolved
  const standIn = process.env.SUPERAGENT_AGENT_DESKTOP
  if (standIn && process.env.SUPERAGENT_IS_PACKAGED !== '1') return (resolved = { executable: standIn })
  if (typeof process !== 'undefined' && process.resourcesPath) {
    const bundled = fromDirectory(path.join(process.resourcesPath, 'agent-desktop'), MACOS_HELPER_NAME)
    if (bundled) return (resolved = bundled)
  }
  const require = createRequire(import.meta.url)
  const binDir = path.join(path.dirname(require.resolve('agent-desktop/package.json')), 'bin')
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const fromPackage = fromDirectory(binDir, MACOS_HELPER_NAME)
    ?? fromDirectory(binDir, `${MACOS_HELPER_NAME}-${process.platform}-${arch}`)
  if (fromPackage) return (resolved = fromPackage)
  const archNamed = process.platform === 'win32' ? fromDirectory(binDir, MACOS_HELPER_NAME, `agent-desktop-win32-${arch}.exe`) : null
  if (!archNamed) {
    throw new Error(`agent-desktop is not installed for ${process.platform}-${arch} (looked in ${binDir})`)
  }
  return (resolved = { executable: agentDesktopNamedCopy(archNamed.executable, path.join(getDataDir(), 'agent-desktop-bin')) })
}

/**
 * A copy of the arch-named Windows executable under the name the CLI needs.
 * agent-desktop starts its cursor overlay only from a binary named
 * `agent-desktop` (from any other, `cursor-overlay enable` answers
 * `rendered: false`), and the package keeps only `agent-desktop-win32-<arch>.exe`.
 * The copy is made again when the package's binary changes. Without one the
 * commands still run, from the package's binary, with no cursor.
 */
export function agentDesktopNamedCopy(executable: string, dir: string): string {
  const copy = path.join(dir, 'agent-desktop.exe')
  try {
    const source = fs.statSync(executable)
    const current = fs.existsSync(copy) ? fs.statSync(copy) : null
    if (!current || current.size !== source.size || current.mtimeMs !== source.mtimeMs) {
      fs.mkdirSync(dir, { recursive: true })
      const temporary = `${copy}.${process.pid}.tmp`
      fs.copyFileSync(executable, temporary)
      // The source's times on the copy are how a later start tells it is current.
      fs.utimesSync(temporary, source.atime, source.mtime)
      fs.renameSync(temporary, copy)
    }
    return copy
  } catch (error) {
    // A copy another app instance is running cannot be replaced: run it as it is.
    if (fs.existsSync(copy)) return copy
    console.warn('[ComputerUse] Could not copy agent-desktop as agent-desktop.exe; agents\' cursors will not show:', error)
    return executable
  }
}

/** For tests: forget the binary found before, so the next command looks again. */
export function forgetAgentDesktopBinary(): void {
  resolved = null
}

/** Where agent-desktop keeps sessions and snapshot refmaps: inside this app's data, apart from any other install. */
export function agentDesktopHome(): string {
  return path.join(getDataDir(), 'agent-desktop')
}

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
  details: z.unknown().optional(),
  disposition: z.object({ delivery: z.string(), retry: z.string() }).partial().optional(),
}).passthrough()

/** The one JSON object every agent-desktop command prints. */
export const envelopeSchema = z.object({
  version: z.string().optional(),
  ok: z.boolean(),
  command: z.string().optional(),
  data: z.unknown().optional(),
  error: errorSchema.optional(),
}).passthrough()

export type AgentDesktopEnvelope = z.infer<typeof envelopeSchema>

let privateHome: string | null = null

/**
 * agent-desktop refuses a state directory others can read ("private file
 * parent is accessible by group or other users"), so make it the owner's
 * alone, whoever created it.
 */
function ensurePrivateDirectory(dir: string): void {
  if (privateHome === dir) return
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
  privateHome = dir
}

/** What one command printed: its text as is, and the envelope in it when there is one. */
export interface AgentDesktopOutput {
  /** stdout, trimmed: the JSON envelope, or text (`--help`, `skills get` content is JSON too). */
  stdout: string
  envelope: AgentDesktopEnvelope | null
  code: number | null
  stderr: string
}

/** The envelope in a command's stdout: the last line that parses as one. */
function envelopeIn(stdout: string): AgentDesktopEnvelope | null {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = envelopeSchema.safeParse(JSON.parse(trimmed))
      if (parsed.success) return parsed.data
    } catch {
      // Not this line.
    }
  }
  return null
}

/** How one command runs: its time limit, and a signal that stops it early. */
export interface AgentDesktopRunOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** Run one agent-desktop command. Resolves to its envelope whether or not the command succeeded. */
export async function runAgentDesktop(args: readonly string[], options: AgentDesktopRunOptions = {}): Promise<AgentDesktopEnvelope> {
  const output = await runAgentDesktopOutput(args, options)
  if (output.envelope) return output.envelope
  throw new Error(`agent-desktop ${args[0] ?? ''} exited with code ${output.code} and printed no result${output.stderr ? `: ${output.stderr.trim().slice(0, 500)}` : ''}`)
}

/** Run one agent-desktop command and keep what it printed, envelope or not. */
export function runAgentDesktopOutput(args: readonly string[], options: AgentDesktopRunOptions = {}): Promise<AgentDesktopOutput> {
  const { executable, macosHelper } = resolveAgentDesktopBinary()
  const home = agentDesktopHome()
  ensurePrivateDirectory(home)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DESKTOP_HOME: home,
    ...(macosHelper && { AGENT_DESKTOP_MACOS_HELPER_PATH: macosHelper }),
  }
  // Session and agent come from the arguments only, never from inherited env.
  delete env.AGENT_DESKTOP_SESSION
  delete env.AGENT_DESKTOP_AGENT_ID

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AgentDesktopAbortedError(args[0] ?? ''))
      return
    }
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    const onAbort = () => {
      child.kill()
      finish(() => reject(new AgentDesktopAbortedError(args[0] ?? '')))
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new AgentDesktopTimeoutError(args[0] ?? '', timeoutMs)))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        finish(() => reject(new Error(`agent-desktop ${args[0] ?? ''} printed more than ${MAX_OUTPUT_BYTES} bytes`)))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => {
      const text = Buffer.concat(stdout).toString('utf8').trim()
      resolve({ stdout: text, envelope: envelopeIn(text), code, stderr })
    }))
  })
}

/** Run a command that must succeed, returning its `data`. */
export async function runAgentDesktopOrThrow(args: readonly string[]): Promise<unknown> {
  const envelope = await runAgentDesktop(args)
  if (!envelope.ok) {
    throw new Error(`agent-desktop ${args[0] ?? ''} failed: ${envelope.error?.code ?? 'ERROR'} ${envelope.error?.message ?? ''}`.trim())
  }
  return envelope.data
}

// --- The parts of a command's data the app reads ---

export const sessionStartDataSchema = z.object({ session_id: z.string() }).passthrough()

/** `cursor-overlay enable`: `rendered` is false when no renderer came up to draw the cursor. */
export const cursorOverlayDataSchema = z.object({ rendered: z.boolean().optional() }).passthrough()

export const snapshotDataSchema = z.object({
  snapshot_id: z.string(),
  app: z.string().optional(),
  window: z.object({ id: z.string() }).passthrough().optional(),
}).passthrough()

/** A screen area in points: window and display bounds. */
const boundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

export const windowListSchema = z.array(z.object({
  id: z.string(),
  app_name: z.string(),
  pid: z.number().optional(),
  title: z.string().optional(),
  bounds: boundsSchema.optional(),
  minimized: z.boolean().optional(),
  is_focused: z.boolean().optional(),
  visible: z.boolean().optional(),
}).passthrough())

export const displayListSchema = z.array(z.object({ bounds: boundsSchema, scale: z.number().optional(), is_primary: z.boolean().optional() }).passthrough())

export const launchDataSchema = z.object({
  app: z.string().optional(),
  window: z.object({ id: z.string() }).passthrough().optional(),
}).passthrough()

export const screenshotDataSchema = z.object({
  data: z.string(),
  format: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  /** Pixels per point of the capture. */
  scale_factor: z.number().optional(),
}).passthrough()

export const permissionsDataSchema = z.object({
  accessibility: z.object({ state: z.string() }).passthrough().optional(),
  screen_recording: z.object({ state: z.string() }).passthrough().optional(),
}).passthrough()
