import { describe, expect, it } from 'vitest'
import { chipOnOverlay, isCaptureRect, screenshotFileName } from './quick-dispatch-capture'

describe('quick-dispatch capture helpers', () => {
  it('names the screenshot as macOS does, in local time', () => {
    expect(screenshotFileName(new Date(2026, 10, 2, 9, 3, 7))).toBe('Screenshot 2026-11-02 at 09.03.07.png')
  })

  it('places the chip on the overlay of the launcher’s display', () => {
    const chip = { x: 16, y: 14, width: 44, height: 44 }
    // A second display to the right of and above the primary one.
    expect(chipOnOverlay(chip, { x: 1900, y: -300 }, { x: 1512, y: -500 })).toEqual({ x: 404, y: 214, width: 44, height: 44 })
  })

  it('accepts only a finite rectangle with an area', () => {
    expect(isCaptureRect({ x: 0, y: 0, width: 44, height: 44 })).toBe(true)
    expect(isCaptureRect({ x: 0, y: 0, width: 0, height: 44 })).toBe(false)
    expect(isCaptureRect({ x: Number.NaN, y: 0, width: 44, height: 44 })).toBe(false)
    expect(isCaptureRect({ x: '0', y: 0, width: 44, height: 44 })).toBe(false)
    expect(isCaptureRect(null)).toBe(false)
  })
})
