/**
 * Where computer use thinks windows and points are on Windows, checked
 * against Windows itself on the real desktop:
 *
 * - A window screenshot's note must name the window's visible frame, as DWM
 *   reports it (DWMWA_EXTENDED_FRAME_BOUNDS), not its bounds with the
 *   invisible resize borders.
 * - A point must be placed in the app whose window a click there reaches, as
 *   WindowFromPoint answers it, over a grid across the whole display.
 *
 * agent-desktop's coordinates on Windows are physical pixels (its display
 * `scale` is the DPI setting, not a conversion), and Windows answers here in
 * physical pixels too, which the test checks before relying on it.
 *
 * Read-only: it takes screenshots and reads window lists, with the agent
 * cursor off, and acts in no app. Skipped unless COMPUTER_USE_REAL=1 on
 * Windows. Keep the desktop still while it runs.
 *
 *   COMPUTER_USE_REAL=1 npx vitest run src/shared/lib/computer-use/executor.windows.real.test.ts
 *
 * COMPUTER_USE_REAL_STEP sets the grid's spacing in pixels (default 96).
 * SUPERAGENT_AGENT_DESKTOP can name an installed agent-desktop.exe.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const REAL = process.env.COMPUTER_USE_REAL === '1' && process.platform === 'win32'
const STEP = Number(process.env.COMPUTER_USE_REAL_STEP) || 96

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ computerUse: { showCursor: false, inputMode: 'headed' } }),
}))

/** Windows' own answers, per-monitor DPI aware: each window's visible frame and rect, and each point's top-level window. */
const GROUND_TRUTH = String.raw`
param([string]$InputPath)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class GroundTruth {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
  public static void Aware() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  public static string WindowsOf(int[] pids) {
    var found = new System.Collections.Generic.List<string>();
    EnumWindows((h, d) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, (int)pid) >= 0 && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        found.Add(r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T));
      }
      return true;
    }, IntPtr.Zero);
    return String.Join(";", found);
  }
  public static int[] Frame(long hwnd) {
    RECT f; RECT w;
    if (DwmGetWindowAttribute(new IntPtr(hwnd), 9, out f, Marshal.SizeOf(typeof(RECT))) != 0) return null;
    if (!GetWindowRect(new IntPtr(hwnd), out w)) return null;
    return new int[] { f.L, f.T, f.R - f.L, f.B - f.T, w.L, w.T, w.R - w.L, w.B - w.T };
  }
  public static string Hit(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr root = GetAncestor(WindowFromPoint(p), 2);
    uint pid; GetWindowThreadProcessId(root, out pid);
    StringBuilder name = new StringBuilder(256); GetClassName(root, name, 256);
    return pid + "|" + name.ToString() + "|" + root.ToInt64();
  }
}
"@
[GroundTruth]::Aware()
$in = Get-Content -Raw $InputPath | ConvertFrom-Json
$names = @{}
Get-Process | ForEach-Object { $names[[int]$_.Id] = $_.ProcessName }
$frames = @{}
foreach ($id in $in.hwnds) { $f = [GroundTruth]::Frame([long]$id); if ($f) { $frames["$id"] = $f } }
$hits = foreach ($p in $in.points) {
  $parts = [GroundTruth]::Hit([int]$p[0], [int]$p[1]) -split '\|'
  @{ pid = [int]$parts[0]; process = $names[[int]$parts[0]]; class = $parts[1]; hwnd = [long]$parts[2] }
}
$owned = if ($in.pids) { [GroundTruth]::WindowsOf([int[]]@($in.pids)) } else { '' }
@{ frames = $frames; hits = @($hits); owned = $owned } | ConvertTo-Json -Depth 5 -Compress
`

interface Truth {
  /** Per window: its visible frame (x, y, width, height), then its window rect. */
  frames: Record<string, number[]>
  hits: Array<{ pid: number; process: string | null; class: string; hwnd: number }>
  /** The visible top-level windows of the processes asked about, as "x,y,width,height" joined by ";". */
  owned: string
}

type Area = { x: number; y: number; width: number; height: number }
type ListedWindow = { id: string; app_name: string; title?: string; pid?: number; minimized?: boolean; bounds?: Area }

describe.skipIf(!REAL)('computer use on this Windows desktop', { timeout: 600_000 }, () => {
  let executor: typeof import('./executor')
  let agentDesktop: typeof import('./agent-desktop')
  let dataDir = ''
  let display: Area = { x: 0, y: 0, width: 0, height: 0 }
  const caller = { sessionId: 'windows-real', agentSlug: 'agent-real', label: 'Windows Real Test' }

  const groundTruth = (hwnds: number[], points: Array<[number, number]>, pids: number[] = []): Promise<Truth> => {
    const script = path.join(dataDir, 'ground-truth.ps1')
    const input = path.join(dataDir, 'ground-truth-input.json')
    fs.writeFileSync(script, GROUND_TRUTH)
    fs.writeFileSync(input, JSON.stringify({ hwnds, points, pids }))
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, input], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`))
        else resolve(JSON.parse(stdout) as Truth)
      })
    })
  }

  const listWindows = async () => (await agentDesktop.runAgentDesktop(['list-windows'])).data as ListedWindow[]
  const hwndOf = (window: ListedWindow) => Number(window.id.replace(/^w-/, ''))
  const processOf = (app: string) => app.toLowerCase().replace(/\.exe$/, '')

  beforeAll(async () => {
    // agent-desktop refuses a session home whose ACL lets others in, which a folder under %TEMP% can.
    dataDir = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'gamut-computer-use-win-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    executor = await import('./executor')
    agentDesktop = await import('./agent-desktop')
    const displays = (await agentDesktop.runAgentDesktop(['list-displays'])).data as Array<{ bounds: Area }>
    // The grid covers one display; more would need their own grids.
    expect(displays, 'this test reads one display').toHaveLength(1)
    display = displays[0].bounds
  })

  afterAll(async () => {
    await executor?.endComputerUseSessions()
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  /** The shown windows listed both before and after `read`: one that opened or closed meanwhile (a browser's popup) is left out. */
  const steadyWindows = async <T,>(read: (windows: ListedWindow[]) => Promise<T>): Promise<{ windows: ListedWindow[]; result: T }> => {
    const first = (await listWindows()).filter((window) => !window.minimized && window.bounds)
    const result = await read(first)
    const again = new Set((await listWindows()).map((window) => `${window.id} ${JSON.stringify(window.bounds)}`))
    return { windows: first.filter((window) => again.has(`${window.id} ${JSON.stringify(window.bounds)}`)), result }
  }

  it('reads windows in the same pixels as Windows does', async () => {
    const { windows, result: truth } = await steadyWindows((listed) => groundTruth(listed.map(hwndOf), []))
    for (const window of windows) {
      const rect = truth.frames[String(hwndOf(window))]?.slice(4)
      expect(rect, `${window.app_name} ${window.id} is not a window Windows knows`).toBeDefined()
      expect({ x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, window.app_name).toEqual(window.bounds)
    }
  })

  it('says each window screenshot shows the window\'s visible frame', async () => {
    const { windows, result: [truth, notes] } = await steadyWindows(async (listed) => {
      const frames = await groundTruth(listed.map(hwndOf), [])
      const taken = new Map<string, string>()
      for (const window of listed) {
        const result = await executor.executeComputerUseCommand('screenshot', { window_id: window.id }, caller)
        taken.set(window.id, String(JSON.parse(result.output).note))
      }
      return [frames, taken] as const
    })
    expect(windows.length).toBeGreaterThan(0)
    const rows: string[] = []
    const wrong: string[] = []
    for (const window of windows) {
      const note = notes.get(window.id)!
      const frame = truth.frames[String(hwndOf(window))]
      const expected = { x: frame[0], y: frame[1], width: frame[2], height: frame[3] }
      const match = /at screen points x (-?[\d.]+)–(-?[\d.]+), y (-?[\d.]+)–(-?[\d.]+)/.exec(note)
      const got = match && { x: +match[1], y: +match[3], width: +match[2] - +match[1], height: +match[4] - +match[3] }
      const row = `${window.app_name} ${window.id} bounds ${JSON.stringify(window.bounds)} visible ${JSON.stringify(expected)} note ${got ? JSON.stringify(got) : note}`
      rows.push(row)
      if (!got || (['x', 'y', 'width', 'height'] as const).some((key) => Math.abs(got[key] - expected[key]) > 1)) wrong.push(row)
    }
    console.log(rows.join('\n'))
    expect(wrong, wrong.join('\n')).toEqual([])
  })

  const grid = (): Array<[number, number]> => {
    const points: Array<[number, number]> = []
    for (let y = display.y + STEP / 2; y < display.y + display.height; y += STEP) {
      for (let x = display.x + STEP / 2; x < display.x + display.width; x += STEP) points.push([Math.round(x), Math.round(y)])
    }
    return points
  }

  it('prepares the hit test, and it answers as WindowFromPoint does across the display', async () => {
    const hitTest = await import('./windows-hit-test')
    expect(await hitTest.prepareWindowsHitTest(), 'the hit test could not be compiled').toBeTruthy()
    const points = grid()
    const truth = await groundTruth([], points)
    const hits = await hitTest.windowsAtPoints(points.map(([x, y]) => ({ x, y })))
    expect(hits).not.toBeNull()
    const differ = points.flatMap(([x, y], i) => (hits![i].hwnd === truth.hits[i].hwnd ? [] : [`(${x}, ${y}): ${hits![i].hwnd} [${hits![i].className}] vs ${truth.hits[i].hwnd} [${truth.hits[i].class}]`]))
    expect(differ, differ.join('\n')).toEqual([])
  })

  it('places points across the display in the app a click there reaches', async () => {
    const points = grid()
    const before: Truth['hits'] = []
    const after: Truth['hits'] = []
    const listedAt: ListedWindow[][] = []
    const placed: Array<string | undefined> = []
    const took: number[] = []
    // A row at a time, Windows and the window list asked just before and just
    // after it, so a desktop that moves during the run spoils one row, not the
    // whole grid, and each point is held to the windows of its own moment.
    const rowLength = points.filter(([, y]) => y === points[0][1]).length
    for (let start = 0; start < points.length; start += rowLength) {
      const row = points.slice(start, start + rowLength)
      const windowsBefore = JSON.stringify(await listWindows())
      before.push(...(await groundTruth([], row)).hits)
      for (const [x, y] of row) {
        const began = Date.now()
        placed.push(await executor.resolveComputerUseTargetApp('mouse-click', { xy: `${x},${y}`, headed: true }).catch((error: Error) => `error: ${error.message}`))
        took.push(Date.now() - began)
      }
      after.push(...(await groundTruth([], row)).hits)
      const windowsAfter = await listWindows()
      // The list changed during the row (a window minimized, moved or opened): its points are not compared.
      const settled = JSON.stringify(windowsAfter) === windowsBefore
      for (let i = 0; i < row.length; i++) listedAt.push(settled ? windowsAfter.filter((window) => !window.minimized) : [])
    }

    const wrong: string[] = []
    let compared = 0
    let nowhere = 0
    points.forEach(([x, y], i) => {
      const hit = before[i]
      const windows = listedAt[i]
      // The desktop changed under this point while the test ran: no answer to hold it to.
      if (hit.hwnd !== after[i].hwnd || windows.length === 0) return
      compared++
      const truthApp = `${hit.process ?? `pid ${hit.pid}`} [${hit.class}]`
      const got = placed[i] === undefined ? undefined : processOf(placed[i]!)
      if (got === undefined) nowhere++
      // The window a click there reaches, if it is listed: that app, and nothing else.
      const listed = windows.find((window) => hwndOf(window) === hit.hwnd)
      if (listed) {
        if (got !== processOf(listed.app_name)) wrong.push(`(${x}, ${y}): placed ${placed[i] ?? 'nowhere'}, the click reaches ${listed.app_name}'s window ${listed.id}`)
        return
      }
      // Anything else (the taskbar, the desktop, Start, a popup): never
      // another process's app. Nowhere (the user is asked) is always safe.
      const sameProcess = windows.filter((window) => window.pid === hit.pid).map((window) => processOf(window.app_name))
      if (got !== undefined && !sameProcess.includes(got)) wrong.push(`(${x}, ${y}): placed ${placed[i]}, the click reaches ${truthApp}, which is not listed`)
    })
    const sorted = [...took].sort((a, b) => a - b)
    console.log(`compared ${compared} of ${points.length} points; ${nowhere} placed nowhere; ${wrong.length} wrong; placing took median ${sorted[Math.floor(sorted.length / 2)]} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)]} ms`)
    expect(wrong, wrong.join('\n')).toEqual([])
  })

  it('frames and places a Store app\'s window, hosted by another process, by the app\'s own name', async () => {
    const launched = await executor.executeComputerUseCommand('launch', { app: 'Calculator' }, caller)
    expect(launched.app, launched.output).toBe('CalculatorApp.exe')
    try {
      let calculator: ListedWindow | undefined
      for (let attempt = 0; attempt < 20 && !calculator?.bounds; attempt++) {
        calculator = (await listWindows()).find((window) => window.app_name === 'CalculatorApp.exe' && !window.minimized)
        if (!calculator?.bounds) await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(calculator?.bounds, 'Calculator\'s window never showed').toBeDefined()
      const { x, y, width, height } = calculator!.bounds!
      const truth = await groundTruth([hwndOf(calculator!)], [[Math.round(x + width / 2), Math.round(y + height / 2)]])
      // Hosted: the window a click reaches belongs to the frame host, not to CalculatorApp.exe.
      console.log(`Calculator's window ${calculator!.id}: Windows says ${truth.hits[0].process} [${truth.hits[0].class}]`)

      const shot = JSON.parse((await executor.executeComputerUseCommand('screenshot', { window_id: calculator!.id }, caller)).output)
      const frame = truth.frames[String(hwndOf(calculator!))]
      expect(String(shot.note)).toContain(`at screen points x ${frame[0]}–${frame[0] + frame[2]}, y ${frame[1]}–${frame[1] + frame[3]}`)

      if (truth.hits[0].hwnd === hwndOf(calculator!)) {
        expect(await executor.resolveComputerUseTargetApp('mouse-click', { xy: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`, headed: true })).toBe('CalculatorApp.exe')
      }
    } finally {
      // agent-desktop 1.1.0's close-app cannot find a hosted Store app (it is not in list-apps): end the one this test launched.
      await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Name CalculatorApp -ErrorAction SilentlyContinue'], resolve))
    }
  })

  it('places a click on an app\'s popup in that app', async () => {
    // A throwaway form with a dropdown open beside it, drawn by this PowerShell process.
    const script = path.join(dataDir, 'popup.ps1')
    fs.writeFileSync(script, `Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Gamut Popup Probe'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(40, 40)
$form.Size = New-Object System.Drawing.Size(300, 200)
$form.TopMost = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
1..8 | ForEach-Object { [void]$menu.Items.Add("Item $_") }
$form.Add_Shown({ $menu.Show($form, (New-Object System.Drawing.Point(320, 20))); [Console]::Out.WriteLine('shown'); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($form)
`)
    const child = execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script])
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the probe form never showed')), 15_000)
        child.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('shown')) { clearTimeout(timer); resolve() } })
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const pid = child.pid!
      const listed = (await listWindows()).filter((window) => window.pid === pid)
      const form = listed.find((window) => window.title === 'Gamut Popup Probe')
      expect(form?.bounds, `the probe form is not listed: ${JSON.stringify(listed)}`).toBeDefined()
      const owned = (await groundTruth([], [], [pid])).owned.split(';').filter(Boolean).map((rect) => rect.split(',').map(Number))
      const popup = owned.find(([x, , width]) => x !== form!.bounds!.x || width !== form!.bounds!.width)
      expect(popup, `no popup among ${JSON.stringify(owned)}`).toBeDefined()
      const point: [number, number] = [Math.round(popup![0] + popup![2] / 2), Math.round(popup![1] + popup![3] / 2)]
      const truth = await groundTruth([], [point])
      expect(truth.hits[0].pid, 'the popup is on top at its centre').toBe(pid)
      const popupListed = listed.some((window) => hwndOf(window) === truth.hits[0].hwnd)
      console.log(`the popup [${truth.hits[0].class}] is ${popupListed ? '' : 'not '}in the window list`)
      expect(await executor.resolveComputerUseTargetApp('mouse-click', { xy: `${point[0]},${point[1]}`, headed: true })).toBe('powershell.exe')
    } finally {
      child.kill()
    }
  })

  it('looks through an agent\'s cursor overlay to the window under it', async () => {
    const binary = agentDesktop.resolveAgentDesktopBinary()
    // The overlay draws only from a binary named agent-desktop; it starts at the centre of the work area.
    expect(path.basename(binary.executable).toLowerCase()).toBe('agent-desktop.exe')
    const session = (await agentDesktop.runAgentDesktop(['session', 'start', '--no-trace', '--name=Overlay Probe'])).data as { session_id: string }
    try {
      const enabled = await agentDesktop.runAgentDesktop(['--session', session.session_id, 'cursor-overlay', 'enable', '--label=Overlay Probe'])
      expect((enabled.data as { rendered?: boolean }).rendered).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 800))
      const overlays = await new Promise<string>((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', `Get-Process agent-desktop | ForEach-Object Id`], (_error, stdout) => resolve(stdout))
      })
      const overlayPids = [...new Set(overlays.split(/\s+/).filter(Boolean).map(Number))]
      // Sample inside every window the overlays have up, so the points are surely under one.
      const owned = (await groundTruth([], [], overlayPids)).owned.split(';').filter(Boolean).map((rect) => rect.split(',').map(Number))
      expect(owned.length, 'no overlay window is up').toBeGreaterThan(0)
      const points: Array<[number, number]> = []
      for (const [x, y, width, height] of owned) {
        for (let fy = 0.1; fy < 1; fy += 0.2) for (let fx = 0.1; fx < 1; fx += 0.2) points.push([Math.round(x + width * fx), Math.round(y + height * fy)])
      }
      const hitTest = await import('./windows-hit-test')
      const hits = await hitTest.windowsAtPoints(points.map(([x, y]) => ({ x, y })))
      expect(hits).not.toBeNull()
      const onOverlay = hits!.filter((hit) => overlayPids.includes(hit.pid))
      console.log(`${points.length} points inside ${owned.length} overlay windows; ${onOverlay.length} hit an overlay`)
      expect(onOverlay, JSON.stringify(onOverlay.slice(0, 5))).toEqual([])
    } finally {
      await agentDesktop.runAgentDesktop(['--session', session.session_id, 'cursor-overlay', 'disable']).catch(() => {})
      await agentDesktop.runAgentDesktop(['session', 'end', session.session_id]).catch(() => {})
    }
  })
})
