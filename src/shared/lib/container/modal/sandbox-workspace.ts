/**
 * The workspace as the running sandbox sees it.
 *
 * A sandbox mounts the volume as it was when it started and cannot reload it
 * while the agent holds files open, which the agent always does. So while
 * the sandbox runs, a write from this host goes through the sandbox: the
 * file lands in the agent's own view at once, and a `sync` right after makes
 * the volume commit it, so this host's reads (which stay on the volume) see
 * it too. Everything runs as the agent's user, so what is written is the
 * agent's to edit.
 *
 * A leaf, like `modal-sandboxes.ts`: the actor package imports it without
 * pulling in the runtime client.
 */
import type { Sandbox } from 'modal'
import { getSandbox } from './modal-sandboxes'

/** `USER claude` (uid/gid 1000) in agent-container/Dockerfile. */
const AGENT_UID = 1000
const WORKSPACE_ROOT = '/workspace'
const STDIN_CHUNK_BYTES = 1024 * 1024
const EXEC_TIMEOUT_MS = 120_000

export type LiveEntryKind = 'file' | 'directory' | null

/** Writes into a workspace that an agent is using right now. */
export interface LiveWorkspace {
  /** What is at a workspace path, in the agent's view. */
  stat(rel: string): Promise<LiveEntryKind>
  /** Replace a whole file, creating parents; committed to the volume before returning. */
  write(rel: string, bytes: Uint8Array, mode: number): Promise<void>
  /** Remove a file, or a tree with `recursive`. */
  remove(rel: string, recursive: boolean): Promise<void>
  /** Create a directory and its parents, with the marker file that keeps it on the volume. */
  mkdir(rel: string, marker: string, mode: number): Promise<void>
}

export class SandboxExecError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`Sandbox command exited with ${exitCode}: ${stderr.trim() || '(no output)'}`)
    this.name = 'SandboxExecError'
  }
}

function absolute(rel: string): string {
  return rel === '' ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${rel}`
}

/** A shell script run as the agent user; `$0`, `$1`, … are the arguments, never interpolated. */
function asAgent(script: string, ...args: string[]): string[] {
  return ['setpriv', `--reuid=${AGENT_UID}`, `--regid=${AGENT_UID}`, '--init-groups', 'sh', '-c', script, ...args]
}

export class SandboxWorkspace implements LiveWorkspace {
  constructor(private readonly sandbox: Sandbox) {}

  private async run(command: string[], stdin?: Uint8Array): Promise<string> {
    const process = await this.sandbox.exec(command, { mode: 'binary', timeoutMs: EXEC_TIMEOUT_MS })
    if (stdin) {
      for (let offset = 0; offset < stdin.byteLength; offset += STDIN_CHUNK_BYTES) {
        await process.stdin.writeBytes(stdin.subarray(offset, Math.min(stdin.byteLength, offset + STDIN_CHUNK_BYTES)))
      }
    }
    await process.stdin.close()
    const [stdout, stderr, exitCode] = await Promise.all([process.stdout.readBytes(), process.stderr.readBytes(), process.wait()])
    if (exitCode !== 0) throw new SandboxExecError(exitCode, new TextDecoder().decode(stderr))
    return new TextDecoder().decode(stdout)
  }

  async stat(rel: string): Promise<LiveEntryKind> {
    const out = await this.run(asAgent('if [ -d "$0" ]; then echo directory; elif [ -e "$0" ]; then echo file; else echo none; fi', absolute(rel)))
    const kind = out.trim()
    return kind === 'directory' || kind === 'file' ? kind : null
  }

  async write(rel: string, bytes: Uint8Array, mode: number): Promise<void> {
    await this.run(
      asAgent(
        'mkdir -p "$(dirname "$0")" && cat > "$0" && chmod "$1" "$0" && sync "$0"',
        absolute(rel),
        mode.toString(8),
      ),
      bytes,
    )
  }

  async remove(rel: string, recursive: boolean): Promise<void> {
    await this.run(asAgent(recursive ? 'rm -rf "$0" && sync "$(dirname "$0")"' : 'rm -f "$0" && sync "$(dirname "$0")"', absolute(rel)))
  }

  async mkdir(rel: string, marker: string, mode: number): Promise<void> {
    await this.run(
      asAgent('mkdir -p "$0" && : > "$0/$1" && chmod "$2" "$0/$1" && sync "$0/$1"', absolute(rel), marker, mode.toString(8)),
    )
  }
}

/** The agent's live workspace when its sandbox is known to this process, else null. */
export function liveWorkspaceFor(slug: string): LiveWorkspace | null {
  const state = getSandbox(slug)
  return state ? new SandboxWorkspace(state.sandbox) : null
}
