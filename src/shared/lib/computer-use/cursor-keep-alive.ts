/**
 * Keeps an agent's cursor on screen while its turn uses the computer.
 *
 * agent-desktop draws the cursor from a process of its own (the overlay),
 * which fades the cursor out once six seconds pass without a control from a
 * command (`CURSOR_IDLE_REST_MS`), so the cursor is gone between an agent's
 * steps. The CLI has no flag for that time. The overlay takes its controls
 * on a socket, and a `show` control restarts the six seconds and puts a faded
 * cursor back where it was, without moving it; the CLI itself never sends
 * one. This sends one every few seconds, from a session's first command of a
 * turn until the turn ends.
 *
 * It speaks agent-desktop's own protocol to its overlay, which the CLI does
 * not offer to callers: the socket's name and the control are as
 * `crates/macos/src/system/cursor_overlay/` has them in the version this app
 * pins (see the `update-agent-desktop` skill). When a later version changes
 * either, no socket answers and the cursor fades as agent-desktop has it;
 * nothing else depends on this. macOS only: the Windows overlay is reached
 * over a named pipe with its own framing, and is left to fade.
 *
 * A timer of its own, not a Task: this is a heartbeat on a local socket (see
 * docs/background-work.md, "Left where they are").
 */

import * as net from 'net'
import * as path from 'path'
import { background } from '@shared/lib/background'

/** How often a control is sent: half the time the overlay waits before it fades the cursor. */
export const KEEP_ALIVE_INTERVAL_MS = 3_000

/**
 * How long after a session's last command its cursor is still kept, when
 * nothing said the turn ended (the notice is a send, which can be lost).
 */
export const KEEP_ALIVE_QUIET_LIMIT_MS = 5 * 60_000

/** How long one control may take to be acknowledged. */
const CONTROL_TIMEOUT_MS = 1_000

/** The protocol generation agent-desktop hashes into its socket's name (`endpoint.rs`). */
const OVERLAY_PROTOCOL = 'v2'

/** The longest socket path agent-desktop keeps under its home; a longer one goes under /tmp. */
const MAX_SOCKET_PATH_BYTES = 100

/** FNV-1a over the bytes, 64 bits, as 16 hex digits: agent-desktop's `endpoint_hash`. */
function endpointHash(...parts: string[]): string {
  let hash = 0xcbf29ce484222325n
  for (const part of parts) {
    for (const byte of Buffer.from(part, 'utf8')) {
      hash ^= BigInt(byte)
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
    }
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * The socket the overlay of an agent-desktop session listens on, given the
 * home the CLI ran with (`AGENT_DESKTOP_HOME`).
 */
export function overlaySocketPath(home: string, agentDesktopSession: string, uid: number = process.geteuid?.() ?? 0): string {
  const name = `.cursor-overlay-${endpointHash(home, agentDesktopSession, OVERLAY_PROTOCOL)}.sock`
  const underHome = path.join(home, name)
  return Buffer.byteLength(underHome, 'utf8') < MAX_SOCKET_PATH_BYTES
    ? underHome
    : path.join('/tmp', `agent-desktop-${uid}`, name)
}

/**
 * Send the overlay one `show` control. Resolves to whether the overlay
 * acknowledged it; false when none is listening, or it did not answer.
 */
export function sendShowControl(socketPath: string, agentDesktopSession: string): Promise<boolean> {
  return new Promise((resolve) => {
    let acknowledged = false
    // The overlay reads a control to the end of the stream, then answers one byte.
    const socket = net.createConnection({ path: socketPath, allowHalfOpen: true })
    const finish = () => {
      socket.destroy()
      resolve(acknowledged)
    }
    socket.setTimeout(CONTROL_TIMEOUT_MS, finish)
    socket.once('connect', () => socket.end(JSON.stringify({ action: 'show', session_id: agentDesktopSession })))
    socket.once('data', () => {
      acknowledged = true
      finish()
    })
    socket.once('error', finish)
    socket.once('close', finish)
  })
}

interface KeptCursor {
  agentDesktopSession: string
  socketPath: string
  /** When the session's last command started or finished. */
  lastCommandAt: number
  /** A command sending physical input is running: agent-desktop hides the cursor for it. */
  physicalInput: boolean
  timer: ReturnType<typeof setInterval>
}

/** App session id → its cursor being kept on screen. */
const kept = new Map<string, KeptCursor>()

function beat(sessionId: string): void {
  const cursor = kept.get(sessionId)
  if (!cursor) return
  if (Date.now() - cursor.lastCommandAt > KEEP_ALIVE_QUIET_LIMIT_MS) {
    letCursorRest(sessionId)
    return
  }
  if (cursor.physicalInput) return
  background(sendShowControl(cursor.socketPath, cursor.agentDesktopSession), { name: 'computer-use.cursor-keep-alive' })
}

/**
 * A command of an app session is starting, with its cursor shown: keep the
 * cursor on screen from now on. `physicalInput` when the command sends
 * physical input (`--headed`), which agent-desktop hides the cursor for;
 * nothing is sent until the command is done.
 */
export function keepCursorOnScreen(
  sessionId: string,
  agentDesktopSession: string,
  home: string,
  physicalInput = false,
): void {
  if (process.platform !== 'darwin') return
  let cursor = kept.get(sessionId)
  if (cursor && cursor.agentDesktopSession !== agentDesktopSession) {
    letCursorRest(sessionId)
    cursor = undefined
  }
  if (!cursor) {
    const timer = setInterval(() => beat(sessionId), KEEP_ALIVE_INTERVAL_MS)
    // The heartbeat never keeps the process running.
    timer.unref?.()
    cursor = {
      agentDesktopSession,
      socketPath: overlaySocketPath(home, agentDesktopSession),
      lastCommandAt: Date.now(),
      physicalInput,
      timer,
    }
    kept.set(sessionId, cursor)
    return
  }
  cursor.lastCommandAt = Date.now()
  cursor.physicalInput = physicalInput
}

/** The command of an app session that was running is done. */
export function cursorCommandDone(sessionId: string): void {
  const cursor = kept.get(sessionId)
  if (!cursor) return
  cursor.lastCommandAt = Date.now()
  cursor.physicalInput = false
}

/**
 * Stop keeping an app session's cursor on screen (its turn ended, its cursor
 * was turned off, or its agent-desktop session ended), or every session's.
 * agent-desktop then fades it as it does any idle cursor.
 */
export function letCursorRest(sessionId?: string): void {
  for (const [id, cursor] of kept) {
    if (sessionId !== undefined && id !== sessionId) continue
    clearInterval(cursor.timer)
    kept.delete(id)
  }
}

/** Whether an app session's cursor is being kept on screen. */
export function isKeepingCursor(sessionId: string): boolean {
  return kept.has(sessionId)
}
