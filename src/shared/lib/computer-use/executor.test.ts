import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the AC SDK
const mockAC = {
  apps: vi.fn(),
  windows: vi.fn(),
  snapshot: vi.fn(),
  find: vi.fn(),
  screenshot: vi.fn(),
  read: vi.fn(),
  status: vi.fn(),
  displays: vi.fn(),
  permissions: vi.fn(),
  click: vi.fn(),
  type: vi.fn(),
  fill: vi.fn(),
  key: vi.fn(),
  scroll: vi.fn(),
  select: vi.fn(),
  hover: vi.fn(),
  launch: vi.fn(),
  quit: vi.fn(),
  grab: vi.fn(),
  ungrab: vi.fn(),
  menuClick: vi.fn(),
  dialog: vi.fn(),
  dialogAccept: vi.fn(),
  dialogCancel: vi.fn(),
  shutdown: vi.fn(),
}

vi.mock('@skillful-agents/agent-computer', () => ({
  AC: class MockAC {
    apps = mockAC.apps
    windows = mockAC.windows
    snapshot = mockAC.snapshot
    find = mockAC.find
    screenshot = mockAC.screenshot
    read = mockAC.read
    status = mockAC.status
    displays = mockAC.displays
    permissions = mockAC.permissions
    click = mockAC.click
    type = mockAC.type
    fill = mockAC.fill
    key = mockAC.key
    scroll = mockAC.scroll
    select = mockAC.select
    hover = mockAC.hover
    launch = mockAC.launch
    quit = mockAC.quit
    grab = mockAC.grab
    ungrab = mockAC.ungrab
    menuClick = mockAC.menuClick
    dialog = mockAC.dialog
    dialogAccept = mockAC.dialogAccept
    dialogCancel = mockAC.dialogCancel
    shutdown = mockAC.shutdown
  },
  formatOutput: vi.fn((val: unknown) => JSON.stringify(val)),
}))

// Mock fs
const mockReadFileSync = vi.fn()
const mockUnlinkSync = vi.fn()
vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  default: { readFileSync: (...args: unknown[]) => mockReadFileSync(...args), unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args) },
}))

// Import after mocks
const { executeComputerUseCommand, resolveAppFromWindowRef, ungrabAC, shutdownAC } = await import('./executor')

describe('executeComputerUseCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─── Method dispatch ──────────────────────────────────────────────

  describe('method dispatch', () => {
    it('dispatches apps()', async () => {
      mockAC.apps.mockResolvedValue({ apps: ['Calculator'] })
      const result = await executeComputerUseCommand('apps', {})
      expect(mockAC.apps).toHaveBeenCalled()
      expect(result).toContain('Calculator')
    })

    it('dispatches windows(app)', async () => {
      mockAC.windows.mockResolvedValue({ windows: [] })
      await executeComputerUseCommand('windows', { app: 'Safari' })
      expect(mockAC.windows).toHaveBeenCalledWith('Safari')
    })

    it('dispatches snapshot with options', async () => {
      mockAC.snapshot.mockResolvedValue({ elements: [] })
      await executeComputerUseCommand('snapshot', { app: 'X', interactive: true, compact: true, depth: 3 })
      expect(mockAC.snapshot).toHaveBeenCalledWith({ app: 'X', interactive: true, compact: true, depth: 3 })
    })

    it('dispatches click with options', async () => {
      mockAC.click.mockResolvedValue(undefined)
      await executeComputerUseCommand('click', { ref: '@b1', right: true, double: false })
      expect(mockAC.click).toHaveBeenCalledWith('@b1', { right: true, double: false })
    })

    it('dispatches type', async () => {
      mockAC.type.mockResolvedValue(undefined)
      await executeComputerUseCommand('type', { text: 'hello world' })
      expect(mockAC.type).toHaveBeenCalledWith('hello world')
    })

    it('dispatches key with repeat', async () => {
      mockAC.key.mockResolvedValue(undefined)
      await executeComputerUseCommand('key', { combo: 'cmd+a', repeat: 3 })
      expect(mockAC.key).toHaveBeenCalledWith('cmd+a', 3)
    })

    it('dispatches scroll', async () => {
      mockAC.scroll.mockResolvedValue(undefined)
      await executeComputerUseCommand('scroll', { direction: 'down', amount: 5, on: '@s1' })
      expect(mockAC.scroll).toHaveBeenCalledWith('down', { amount: 5, on: '@s1' })
    })

    it('dispatches menuClick', async () => {
      mockAC.menuClick.mockResolvedValue(undefined)
      await executeComputerUseCommand('menuClick', { path: 'File > Save', app: 'TextEdit' })
      expect(mockAC.menuClick).toHaveBeenCalledWith('File > Save', 'TextEdit')
    })
  })

  // ─── Error handling ───────────────────────────────────────────────

  describe('error handling', () => {
    it('throws on AC SDK errors', async () => {
      mockAC.click.mockRejectedValue(new Error('Element not found'))
      await expect(executeComputerUseCommand('click', { ref: '@b1' })).rejects.toThrow('Element not found')
    })

    it('throws for unknown method', async () => {
      await expect(executeComputerUseCommand('nonexistent', {})).rejects.toThrow('Unknown computer use method')
    })
  })

  // ─── Launch auto-grab ─────────────────────────────────────────────

  describe('launch', () => {
    it('launches then auto-grabs and snapshots', async () => {
      mockAC.launch.mockResolvedValue(undefined)
      mockAC.grab.mockResolvedValue(undefined)
      mockAC.snapshot.mockResolvedValue({ elements: [{ ref: '@b1' }] })
      const result = await executeComputerUseCommand('launch', { name: 'Calculator' })
      expect(mockAC.launch).toHaveBeenCalledWith('Calculator', { wait: true })
      expect(mockAC.grab).toHaveBeenCalledWith('Calculator')
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.grabbed).toBe(true)
      expect(parsed.snapshot).toBeDefined()
    })

    it('launch succeeds even if grab fails', async () => {
      mockAC.launch.mockResolvedValue(undefined)
      mockAC.grab.mockRejectedValue(new Error('window not registered'))
      const result = await executeComputerUseCommand('launch', { name: 'Calculator' })
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.grabbed).toBe(false)
    })

    it('launch succeeds even if snapshot fails after grab', async () => {
      mockAC.launch.mockResolvedValue(undefined)
      mockAC.grab.mockResolvedValue(undefined)
      mockAC.snapshot.mockRejectedValue(new Error('snapshot failed'))
      const result = await executeComputerUseCommand('launch', { name: 'Calculator' })
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.grabbed).toBe(true)
      expect(parsed.snapshot).toBeUndefined()
    })

    it('launch CDP error returns hint about relaunch instead of throwing', async () => {
      mockAC.launch.mockRejectedValue(new Error('CDP not available on port 19202 after 15000ms'))
      const result = await executeComputerUseCommand('launch', { name: 'Spotify' })
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain('CDP')
      expect(parsed.hint).toContain('relaunch')
      expect(parsed.hint).toContain('Ask the user for permission')
    })

    it('launch non-CDP error still throws', async () => {
      mockAC.launch.mockRejectedValue(new Error('App not found'))
      await expect(executeComputerUseCommand('launch', { name: 'Nope' })).rejects.toThrow('App not found')
    })
  })

  // ─── Grab auto-snapshot ───────────────────────────────────────────

  describe('grab', () => {
    it('grabs by app name and auto-snapshots', async () => {
      mockAC.grab.mockResolvedValue(undefined)
      mockAC.snapshot.mockResolvedValue({ elements: [] })
      const result = await executeComputerUseCommand('grab', { app: 'Calculator' })
      expect(mockAC.grab).toHaveBeenCalledWith('Calculator')
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.grabbed).toBe('Calculator')
    })

    it('grabs by window ref when app is not provided', async () => {
      mockAC.grab.mockResolvedValue(undefined)
      mockAC.snapshot.mockResolvedValue({ elements: [] })
      await executeComputerUseCommand('grab', { ref: 'AXWindow "Doc"' })
      expect(mockAC.grab).toHaveBeenCalledWith('AXWindow "Doc"')
    })

    it('grab succeeds even if snapshot fails', async () => {
      mockAC.grab.mockResolvedValue(undefined)
      mockAC.snapshot.mockRejectedValue(new Error('timeout'))
      const result = await executeComputerUseCommand('grab', { app: 'Calculator' })
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.grabbed).toBe('Calculator')
      expect(parsed.snapshot).toBeUndefined()
    })
  })

  // ─── Dialog dispatch ──────────────────────────────────────────────

  describe('dialog', () => {
    it('accept action calls dialogAccept', async () => {
      mockAC.dialogAccept.mockResolvedValue(undefined)
      const result = await executeComputerUseCommand('dialog', { action: 'accept', app: 'Finder' })
      expect(mockAC.dialogAccept).toHaveBeenCalledWith('Finder')
      expect(result).toContain('accepted')
    })

    it('cancel action calls dialogCancel', async () => {
      mockAC.dialogCancel.mockResolvedValue(undefined)
      const result = await executeComputerUseCommand('dialog', { action: 'cancel' })
      expect(mockAC.dialogCancel).toHaveBeenCalledWith(undefined)
      expect(result).toContain('cancelled')
    })

    it('no action calls dialog (detect)', async () => {
      mockAC.dialog.mockResolvedValue({ found: false })
      await executeComputerUseCommand('dialog', {})
      expect(mockAC.dialog).toHaveBeenCalled()
    })
  })

  // ─── Screenshot formatting ────────────────────────────────────────

  describe('screenshot formatting', () => {
    it('reads file, encodes base64, and cleans up temp file', async () => {
      const imgBuffer = Buffer.from('fake-png-data')
      mockAC.screenshot.mockResolvedValue({ path: '/tmp/screenshot.png', width: 800, height: 600 })
      mockReadFileSync.mockReturnValue(imgBuffer)

      const result = await executeComputerUseCommand('screenshot', {})
      const parsed = JSON.parse(result)

      expect(parsed.type).toBe('screenshot')
      expect(parsed.base64).toBe(imgBuffer.toString('base64'))
      expect(parsed.width).toBe(800)
      expect(parsed.height).toBe(600)
      expect(parsed.media_type).toBe('image/png')
      // Verify cleanup
      expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/screenshot.png')
    })

    it('returns raw result if file read fails', async () => {
      mockAC.screenshot.mockResolvedValue({ path: '/tmp/missing.png', width: 100, height: 100 })
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })

      const result = await executeComputerUseCommand('screenshot', {})
      const parsed = JSON.parse(result)
      expect(parsed.path).toBe('/tmp/missing.png')
      // No base64 field
      expect(parsed.base64).toBeUndefined()
    })

    it('handles screenshot returning no path', async () => {
      mockAC.screenshot.mockResolvedValue({ width: 100, height: 100 })
      const result = await executeComputerUseCommand('screenshot', {})
      // Should use formatOutput fallback
      expect(result).toBeDefined()
    })
  })

  // ─── formatResult edge cases ──────────────────────────────────────

  describe('formatResult', () => {
    it('returns success message for null/undefined result', async () => {
      mockAC.click.mockResolvedValue(undefined)
      const result = await executeComputerUseCommand('click', { ref: '@b1' })
      expect(result).toBe('click completed successfully.')
    })

    it('returns string results directly', async () => {
      mockAC.status.mockResolvedValue('daemon running')
      const result = await executeComputerUseCommand('status', {})
      expect(result).toBe('daemon running')
    })
  })
})

// ─── resolveAppFromWindowRef ──────────────────────────────────────

describe('resolveAppFromWindowRef', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns app name for matching window ref', async () => {
    mockAC.windows.mockResolvedValue({
      windows: [
        { ref: 'AXWindow "Doc"', app: 'TextEdit' },
        { ref: 'AXWindow "Calc"', app: 'Calculator' },
      ],
    })
    expect(await resolveAppFromWindowRef('AXWindow "Calc"')).toBe('Calculator')
  })

  it('returns undefined when no window matches', async () => {
    mockAC.windows.mockResolvedValue({
      windows: [{ ref: 'AXWindow "Doc"', app: 'TextEdit' }],
    })
    expect(await resolveAppFromWindowRef('AXWindow "Unknown"')).toBeUndefined()
  })

  it('returns undefined when windows() throws', async () => {
    mockAC.windows.mockRejectedValue(new Error('daemon down'))
    expect(await resolveAppFromWindowRef('AXWindow "Doc"')).toBeUndefined()
  })

  it('returns undefined for empty windows list', async () => {
    mockAC.windows.mockResolvedValue({ windows: [] })
    expect(await resolveAppFromWindowRef('AXWindow "Doc"')).toBeUndefined()
  })
})

// ─── ungrabAC / shutdownAC ──────────────────────────────────────

describe('ungrabAC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls ungrab on AC instance', async () => {
    mockAC.ungrab.mockResolvedValue(undefined)
    // Need to initialize the AC instance first
    mockAC.apps.mockResolvedValue({ apps: [] })
    await executeComputerUseCommand('apps', {})
    await ungrabAC()
    expect(mockAC.ungrab).toHaveBeenCalled()
  })

  it('does not throw if ungrab fails', async () => {
    mockAC.ungrab.mockRejectedValue(new Error('nothing grabbed'))
    mockAC.apps.mockResolvedValue({ apps: [] })
    await executeComputerUseCommand('apps', {})
    // Should not throw
    await ungrabAC()
  })
})

describe('shutdownAC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls ungrab then shutdown', async () => {
    mockAC.ungrab.mockResolvedValue(undefined)
    mockAC.shutdown.mockResolvedValue(undefined)
    mockAC.apps.mockResolvedValue({ apps: [] })
    await executeComputerUseCommand('apps', {})
    await shutdownAC()
    expect(mockAC.ungrab).toHaveBeenCalled()
    expect(mockAC.shutdown).toHaveBeenCalled()
  })

  it('continues shutdown even if ungrab fails', async () => {
    mockAC.ungrab.mockRejectedValue(new Error('failed'))
    mockAC.shutdown.mockResolvedValue(undefined)
    mockAC.apps.mockResolvedValue({ apps: [] })
    await executeComputerUseCommand('apps', {})
    await shutdownAC()
    expect(mockAC.shutdown).toHaveBeenCalled()
  })
})
