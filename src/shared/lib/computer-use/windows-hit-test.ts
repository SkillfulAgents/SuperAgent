/**
 * Whose window a click at a screen point reaches on Windows, from Windows
 * itself: WindowFromPoint, the hit test real mouse input goes through.
 *
 * agent-desktop's window list says where windows are but not what is on top
 * of what, and leaves out the shell's own windows (the taskbar, Start,
 * notifications, the desktop) and apps' popups and menus. The hit test sees
 * all of them, and passes through click-through windows such as the agents'
 * cursor overlays, as a real click does. It is the Windows counterpart of
 * the accessibility hit test macOS placement uses (screen-windows.ts).
 *
 * Read through PowerShell, which every Windows has: no helper to build or
 * ship. Compiling its P/Invoke type takes seconds, and a compiled assembly
 * written to disk is refused by Smart App Control, so one PowerShell process
 * compiles it in memory and then answers reads over its stdin, each in
 * milliseconds. It ends itself after ten idle minutes, or when this process
 * goes (its stdin closes), and the next read starts another. Until one is
 * ready, or where it cannot start, reads answer null and placement keeps the
 * window list.
 *
 * Coordinates are physical pixels, read per-monitor DPI aware: the space
 * agent-desktop's window bounds and point commands use on Windows.
 */
import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import type { ScreenPoint } from './commands'

/** The top-level window at a point. */
export interface WindowHit {
  x: number
  y: number
  /** The top-level window (GetAncestor GA_ROOT), as agent-desktop's window id `w-<hwnd>` names it; 0 for none. */
  hwnd: number
  pid: number
  /** Its window class: tells the shell's windows (the taskbar, the desktop) from apps'. */
  className: string
}

/** The helper ends itself after this long with no read. */
const IDLE_EXIT_MS = 10 * 60_000

const SOURCE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class GamutWindowHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  public static string At(int x, int y) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    POINT p; p.X = x; p.Y = y;
    IntPtr hit = WindowFromPoint(p);
    IntPtr root = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, 2);
    uint pid = 0;
    StringBuilder name = new StringBuilder(256);
    if (root != IntPtr.Zero) { GetWindowThreadProcessId(root, out pid); GetClassName(root, name, 256); }
    return x + "\t" + y + "\t" + root.ToInt64() + "\t" + pid + "\t" + name.ToString();
  }
}
`

/**
 * Prints `ready` once the type is compiled, then answers each stdin line of
 * `x,y;x,y` with one line per point and a `.` line.
 */
const HELPER = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${SOURCE}
'@
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $read = [Console]::In.ReadLineAsync()
  if (-not $read.Wait(${IDLE_EXIT_MS})) { break }
  $line = $read.Result
  if ($null -eq $line) { break }
  foreach ($point in ($line -split ';')) {
    if ($point -ne '') { $xy = $point -split ','; [Console]::Out.WriteLine([GamutWindowHitTest]::At([int]$xy[0], [int]$xy[1])) }
  }
  [Console]::Out.WriteLine('.')
  [Console]::Out.Flush()
}
`

/** Starting PowerShell and compiling the type has taken up to eleven seconds cold, three warm. */
const START_TIMEOUT_MS = 20_000
/** A read takes milliseconds; this is for a helper that has stopped answering. */
const READ_TIMEOUT_MS = 2_000
/** After the helper fails to start, how long before it is tried again. */
const RETRY_START_MS = 10 * 60_000

interface Helper {
  child: ChildProcess
  /** True once it can answer; false when it ended or failed first. */
  ready: Promise<boolean>
  /** Reads go one at a time. */
  queue: Promise<unknown>
  lines: string[]
  answer: ((lines: string[] | null) => void) | null
}

let helper: Helper | null = null
let failedAt = 0

function startHelper(): Helper {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HELPER, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
  )
  let setReady: (ready: boolean) => void = () => {}
  const started: Helper = {
    child,
    ready: new Promise<boolean>((resolve) => { setReady = resolve }),
    queue: Promise.resolve(),
    lines: [],
    answer: null,
  }
  let readySeen = false
  // One that has not started in time is stopped, and counts as failed.
  const startTimer = setTimeout(() => { if (!readySeen) child.kill() }, START_TIMEOUT_MS)
  startTimer.unref?.()
  const ended = () => {
    clearTimeout(startTimer)
    if (helper === started) helper = null
    if (!readySeen) failedAt = Date.now()
    setReady(false)
    started.answer?.(null)
    started.answer = null
  }
  child.on('error', ended)
  child.on('exit', ended)
  child.stdin?.on('error', () => {})
  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!readySeen) {
        if (line === 'ready') {
          readySeen = true
          clearTimeout(startTimer)
          setReady(true)
        }
        return
      }
      if (line !== '.') {
        started.lines.push(line)
        return
      }
      const answer = started.answer
      const lines = started.lines
      started.answer = null
      started.lines = []
      answer?.(lines)
    })
  }
  // The helper never keeps this process alive; it ends when its stdin closes.
  child.unref()
  for (const stream of [child.stdin, child.stdout]) (stream as { unref?: () => void } | null)?.unref?.()
  return started
}

function stopHelper(running: Helper): void {
  if (helper === running) helper = null
  running.child.kill()
}

/**
 * Start the hit test, if it is not running: the first read would otherwise
 * wait out PowerShell's start. Resolves true once it can answer, false when
 * it cannot (not Windows, or it failed to start lately).
 */
export function prepareWindowsHitTest(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  if (helper) return helper.ready
  if (Date.now() - failedAt < RETRY_START_MS) return Promise.resolve(false)
  helper = startHelper()
  return helper.ready
}

/** Stop the hit test's helper, if one is running. The next read starts another. */
export function stopWindowsHitTest(): void {
  if (helper) stopHelper(helper)
}

/** Parse the reader's lines; null when any line is not one it prints. */
export function parseWindowHits(lines: readonly string[]): WindowHit[] | null {
  const hits: WindowHit[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const [x, y, hwnd, pid, ...className] = line.split('\t')
    const numbers = [x, y, hwnd, pid].map(Number)
    if (numbers.some((value) => !Number.isFinite(value))) return null
    hits.push({ x: numbers[0], y: numbers[1], hwnd: numbers[2], pid: numbers[3], className: className.join('\t') })
  }
  return hits
}

function ask(running: Helper, asked: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Not answering: stopped, so the next read starts afresh.
      running.answer = null
      stopHelper(running)
      resolve(null)
    }, READ_TIMEOUT_MS)
    running.answer = (lines) => {
      clearTimeout(timer)
      resolve(lines)
    }
    running.child.stdin?.write(`${asked}\n`)
  })
}

/**
 * The top-level window at each point, in order; null when Windows cannot be
 * asked this way (not Windows, the helper failed to start, or a read failed).
 * The first read in a while waits for the helper to start.
 */
export async function windowsAtPoints(points: readonly ScreenPoint[]): Promise<WindowHit[] | null> {
  if (process.platform !== 'win32' || points.length === 0) return null
  if (!(await prepareWindowsHitTest())) return null
  const running = helper
  if (!running) return null
  const asked = points.map((point) => `${Math.round(point.x)},${Math.round(point.y)}`).join(';')
  const read = running.queue.then(() => ask(running, asked))
  running.queue = read.catch(() => {})
  const hits = parseWindowHits((await read) ?? ['not an answer'])
  return hits && hits.length === points.length ? hits : null
}
