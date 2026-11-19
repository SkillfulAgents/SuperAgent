import { describe, expect, it } from 'vitest'
import { appAtPoint, frontmostApp, parseScreenWindows, windowAt, type ScreenWindow } from './screen-windows'

const win = (owner: string, x: number, y: number, width: number, height: number, more: Partial<ScreenWindow> = {}): ScreenWindow =>
  ({ pid: 1, owner, alpha: 1, layer: 0, bounds: { x, y, width, height }, ...more })

// A display with a menu bar above its usable area and a Dock below, and a second one beside it with neither.
const displays = [
  { frame: { x: 0, y: 0, width: 1728, height: 1117 }, usable: { x: 0, y: 33, width: 1728, height: 1010 } },
  { frame: { x: 1728, y: 0, width: 2560, height: 1440 }, usable: { x: 1728, y: 0, width: 2560, height: 1440 } },
]

describe('parseScreenWindows', () => {
  it('reads the windows in their order, the frontmost app, the displays and the hits', () => {
    const output = JSON.stringify({
      displays,
      frontmost: { pid: 1410, name: 'Safari' },
      windows: [
        { pid: 31955, owner: 'agent-desktop', alpha: 1, layer: 24, bounds: { X: 406, Y: 223, Width: 108, Height: 108 } },
        { pid: 1414, owner: 'Notes', alpha: 1, layer: 0, bounds: { X: 0, Y: 33, Width: 1728, Height: 1026 } },
      ],
      hits: [{ x: 462, y: 297, pid: 1414, name: 'Notes' }, { x: 5, y: 5, pid: null, name: null }],
    })
    expect(parseScreenWindows(output)).toEqual({
      displays,
      frontmost: { pid: 1410, name: 'Safari' },
      windows: [
        { pid: 31955, owner: 'agent-desktop', alpha: 1, layer: 24, bounds: { x: 406, y: 223, width: 108, height: 108 } },
        { pid: 1414, owner: 'Notes', alpha: 1, layer: 0, bounds: { x: 0, y: 33, width: 1728, height: 1026 } },
      ],
      hits: [{ x: 462, y: 297, pid: 1414, name: 'Notes' }, { x: 5, y: 5 }],
    })
  })

  it('reads a window with no owner name, opacity or level, and no frontmost app or hits', () => {
    const output = JSON.stringify({ displays: [], frontmost: null, windows: [{ pid: 9, bounds: { X: 0, Y: 0, Width: 10, Height: 10 } }] })
    expect(parseScreenWindows(output)).toEqual({
      displays: [],
      windows: [{ pid: 9, owner: '', alpha: 1, layer: 0, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
      hits: [],
    })
  })

  it.each(['', 'not json', '{"windows":[]}', '{"displays":[],"windows":"none"}', '{"displays":[],"windows":[{"pid":"x","bounds":{}}]}'])('answers nothing for %j', (output) => {
    expect(parseScreenWindows(output)).toBeUndefined()
  })
})

describe('appAtPoint', () => {
  const notes = win('Notes', 0, 33, 1728, 1010, { pid: 3 })
  const point = { x: 462, y: 297 }

  it('is the app accessibility\'s hit test found, under the name its windows carry', () => {
    // The window server names the process 'Safari'; macOS shows this helper under another name.
    const safari = win('Safari', 0, 33, 1728, 1010, { pid: 7 })
    const screen = { displays, windows: [notes, safari], hits: [{ ...point, pid: 7, name: 'talagentd' }] }
    expect(appAtPoint(point, screen)).toEqual({ pid: 7, name: 'Safari' })
  })

  it('takes the hit test over the window in front, which may let clicks through', () => {
    const overlay = win('Screenshot', 0, 0, 1728, 1117, { pid: 9, layer: 24 })
    expect(appAtPoint(point, { displays, windows: [overlay, notes], hits: [{ ...point, pid: 3, name: 'Notes' }] })).toEqual({ pid: 3, name: 'Notes' })
  })

  it('names an app with no window on screen as macOS shows it: the Dock, the desktop\'s Finder', () => {
    expect(appAtPoint({ x: 800, y: 1100 }, { displays, windows: [notes], hits: [{ x: 800, y: 1100, pid: 77, name: 'Dock' }] })).toEqual({ pid: 77, name: 'Dock' })
    expect(appAtPoint(point, { displays, windows: [], hits: [{ ...point, pid: 78 }] })).toBeUndefined()
  })

  it('falls back to the window list for a point the hit test did not answer', () => {
    expect(appAtPoint(point, { displays, windows: [notes], hits: [{ ...point }] })).toEqual({ pid: 3, name: 'Notes' })
    expect(appAtPoint(point, { displays, windows: [notes], hits: [] })).toEqual({ pid: 3, name: 'Notes' })
    expect(appAtPoint({ x: 800, y: 1100 }, { displays, windows: [notes], hits: [] })).toBeUndefined()
  })
})

describe('frontmostApp', () => {
  it('is the app with focus, under the name its windows carry', () => {
    const safari = win('Safari', 0, 33, 1728, 1010, { pid: 7 })
    expect(frontmostApp({ displays, windows: [safari], hits: [], frontmost: { pid: 7, name: 'talagentd' } })).toEqual({ pid: 7, name: 'Safari' })
    expect(frontmostApp({ displays, windows: [], hits: [], frontmost: { pid: 7, name: 'Safari' } })).toEqual({ pid: 7, name: 'Safari' })
    expect(frontmostApp({ displays, windows: [safari], hits: [] })).toBeUndefined()
  })
})

describe('windowAt', () => {
  const notes = win('Notes', 0, 33, 1728, 1010)

  it('is the first window, front to back, that covers the point', () => {
    const mail = win('Mail', 400, 100, 500, 500, { pid: 2 })
    expect(windowAt({ x: 450, y: 150 }, { displays, windows: [mail, notes] })).toBe(mail)
    expect(windowAt({ x: 450, y: 150 }, { displays, windows: [notes, mail] })).toBe(notes)
    expect(windowAt({ x: 100, y: 150 }, { displays, windows: [mail, notes] })).toBe(notes)
  })

  it('counts a window\'s left and top edges as inside, its right and bottom as outside', () => {
    const small = win('Notes', 100, 100, 200, 200)
    expect(windowAt({ x: 100, y: 100 }, { displays, windows: [small] })).toBe(small)
    expect(windowAt({ x: 300, y: 150 }, { displays, windows: [small] })).toBeUndefined()
    expect(windowAt({ x: 150, y: 300 }, { displays, windows: [small] })).toBeUndefined()
  })

  // The Dock keeps an invisible window over the whole display, in front of every app's.
  it('passes through the Dock\'s and the menu bar\'s windows, the agent\'s cursor overlay, a fully transparent window and one with no owner name', () => {
    const inFront = [
      win('Window Server', 0, 0, 1728, 33, { layer: 24 }),
      win('agent-desktop', 400, 240, 108, 108, { layer: 24 }),
      win('Dock', 0, 0, 1728, 1117, { layer: 20 }),
      win('Overlay', 0, 0, 1728, 1117, { alpha: 0, layer: 25 }),
      win('', 0, 0, 1728, 1117, { layer: 25 }),
    ]
    expect(windowAt({ x: 462, y: 297 }, { displays, windows: [...inFront, notes] })).toBe(notes)
    expect(windowAt({ x: 462, y: 297 }, { displays, windows: inFront })).toBeUndefined()
  })

  // The list cannot say whether a window above the ordinary level takes clicks or lets them through.
  it('cannot tell under another app\'s panel or overlay, but can under the app\'s own menu', () => {
    const overlay = win('Screenshot', 0, 0, 1728, 1117, { pid: 9, layer: 24 })
    expect(windowAt({ x: 462, y: 297 }, { displays, windows: [overlay, notes] })).toBeUndefined()
    const menu = win('Notes', 440, 280, 200, 300, { layer: 101 })
    expect(windowAt({ x: 462, y: 297 }, { displays, windows: [menu, notes] })).toBe(notes)
  })

  // A window takes clicks a few points past its frame (its resize border), so
  // there the window behind is not a safe answer.
  it('cannot tell just outside the frame of another app\'s window in front, but can for a window of the same app', () => {
    const front = win('Mail', 400, 100, 500, 500, { pid: 2 })
    const screen = { displays, windows: [front, notes] }
    expect(windowAt({ x: 903, y: 300 }, screen)).toBeUndefined()
    expect(windowAt({ x: 397, y: 300 }, screen)).toBeUndefined()
    expect(windowAt({ x: 600, y: 603 }, screen)).toBeUndefined()
    expect(windowAt({ x: 906, y: 300 }, screen)).toBe(notes)
    expect(windowAt({ x: 899, y: 300 }, screen)).toBe(front)
    const palette = win('Notes', 400, 100, 500, 500)
    expect(windowAt({ x: 903, y: 300 }, { displays, windows: [palette, notes] })).toBe(notes)
  })

  it('finds no app window on the menu bar, on the Dock or off every display, whatever window covers the point', () => {
    const everywhere = win('Notes', -5000, -5000, 20000, 20000)
    expect(windowAt({ x: 400, y: 10 }, { displays, windows: [everywhere] })).toBeUndefined()
    expect(windowAt({ x: 800, y: 1100 }, { displays, windows: [everywhere] })).toBeUndefined()
    expect(windowAt({ x: 9000, y: 100 }, { displays, windows: [everywhere] })).toBeUndefined()
    // The second display has no menu bar or Dock: its top edge is an app's.
    expect(windowAt({ x: 2000, y: 5 }, { displays, windows: [everywhere] })).toBe(everywhere)
  })
})
