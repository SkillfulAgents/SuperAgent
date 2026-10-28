import { afterEach, describe, it, expect } from 'vitest'
import {
  SCREENSHOT_REUSE_MAX_AGE_MS,
  forgetScreenshots,
  parseIfChangedOutput,
  recallScreenshot,
  rememberScreenshot,
  screenshotKey,
} from './screenshot-memory'

afterEach(() => forgetScreenshots())

describe('parseIfChangedOutput', () => {
  // Shapes printed by agent-browser 0.39.1 `screenshot --if-changed --json` in the container.
  it('reads a changed capture with its path, and an unchanged one without', () => {
    expect(parseIfChangedOutput('{"success":true,"data":{"changed":true,"lifecycle":{},"path":"/h/s-1.png","pixelChangeRatio":0.0299,"revision":4,"threshold":0.0},"error":null}'))
      .toEqual({ changed: true, path: '/h/s-1.png', pixelChangeRatio: 0.0299 })
    expect(parseIfChangedOutput('{"success":true,"data":{"changed":false,"lifecycle":{},"pixelChangeRatio":0.0,"revision":2,"threshold":0.0},"error":null}'))
      .toEqual({ changed: false, path: null, pixelChangeRatio: 0 })
  })

  it('returns null for failures and anything unexpected', () => {
    expect(parseIfChangedOutput('{"success":false,"data":null,"error":"Browser not launched"}')).toBeNull()
    expect(parseIfChangedOutput('{"success":true,"data":{"changed":true}}')).toBeNull()
    expect(parseIfChangedOutput('✓ Screenshot unchanged (revision 3, 0.0000% pixels changed)')).toBeNull()
  })
})

describe('remembered screenshots', () => {
  it('are kept per tab and mode, and offered only while recent', () => {
    const viewport = screenshotKey('T1', false)
    rememberScreenshot(viewport, '/s/a.png', 1000)
    expect(recallScreenshot(viewport, 2000)).toEqual({ path: '/s/a.png', takenAt: 1000 })
    expect(recallScreenshot(screenshotKey('T1', true), 2000)).toBeNull()
    expect(recallScreenshot(screenshotKey('T2', false), 2000)).toBeNull()
    expect(recallScreenshot(viewport, 1000 + SCREENSHOT_REUSE_MAX_AGE_MS + 1)).toBeNull()
    forgetScreenshots()
    expect(recallScreenshot(viewport, 2000)).toBeNull()
  })
})
