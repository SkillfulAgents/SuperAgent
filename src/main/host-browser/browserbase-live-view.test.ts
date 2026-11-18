import { describe, it, expect } from 'vitest'
import { pageWsUrlFromDebuggerUrl } from './browserbase-live-view'

describe('pageWsUrlFromDebuggerUrl', () => {
  it('keeps the live-view token from the debugger URL', () => {
    const debuggerUrl =
      'https://www.browserbase.com/devtools/inspector.html?wss=connect.browserbase.com/debug/session-1/devtools/page/PAGE1?t=abc.def-ghi_jkl&debug=true'

    expect(pageWsUrlFromDebuggerUrl(debuggerUrl)).toBe(
      'wss://connect.browserbase.com/debug/session-1/devtools/page/PAGE1?t=abc.def-ghi_jkl',
    )
  })

  it('returns null when the debugger URL is missing or has no socket', () => {
    expect(pageWsUrlFromDebuggerUrl(undefined)).toBeNull()
    expect(pageWsUrlFromDebuggerUrl('https://www.browserbase.com/devtools/inspector.html')).toBeNull()
  })
})
