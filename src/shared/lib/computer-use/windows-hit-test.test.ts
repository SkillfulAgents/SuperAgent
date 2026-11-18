import { afterEach, describe, expect, it } from 'vitest'
import { parseWindowHits, prepareWindowsHitTest, windowsAtPoints } from './windows-hit-test'

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM) })

describe('parseWindowHits', () => {
  it('reads one window per point, in order', () => {
    expect(parseWindowHits(['525\t418\t921266\t3352\tChrome_WidgetWin_1', '900\t1500\t65892\t10844\tShell_TrayWnd'])).toEqual([
      { x: 525, y: 418, hwnd: 921266, pid: 3352, className: 'Chrome_WidgetWin_1' },
      { x: 900, y: 1500, hwnd: 65892, pid: 10844, className: 'Shell_TrayWnd' },
    ])
  })

  it('reads a point with no window there, and negative coordinates on a display left of the main one', () => {
    expect(parseWindowHits(['-100\t20\t0\t0\t'])).toEqual([{ x: -100, y: 20, hwnd: 0, pid: 0, className: '' }])
  })

  it('takes nothing it does not print', () => {
    expect(parseWindowHits(['Add-Type : Cannot add type'])).toBeNull()
  })
})

describe('on other platforms', () => {
  it('asks nothing and prepares nothing', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(await windowsAtPoints([{ x: 1, y: 1 }])).toBeNull()
    expect(await prepareWindowsHitTest()).toBe(false)
  })
})
