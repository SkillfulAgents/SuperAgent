import { describe, it, expect } from 'vitest'
import { capBrowserOutput, redactCdpUrls, MAX_BROWSER_ERROR_CHARS } from './browser-output'

describe('capBrowserOutput', () => {
  it('passes short output through unchanged', () => {
    expect(capBrowserOutput('✓ Done', MAX_BROWSER_ERROR_CHARS)).toBe('✓ Done')
  })

  it('truncates over-cap output with both sizes in the notice', () => {
    const out = capBrowserOutput('x'.repeat(10_000), 4_000)
    expect(out.length).toBeLessThan(4_100)
    expect(out).toContain('showing 4000 of 10000 chars')
  })
})

describe('redactCdpUrls', () => {
  it('redacts the audited CDP WebSocket leak shape', () => {
    const err =
      'Error: Command failed: agent-browser --cdp ws://192.168.5.2:58686/devtools/browser/b1f5f9c3-1c5a-4e0e wait button[disabled=false]'
    const redacted = redactCdpUrls(err)
    expect(redacted).not.toContain('192.168.5.2')
    expect(redacted).toContain('ws://<redacted>')
    expect(redacted).toContain('wait button[disabled=false]')
  })

  it('redacts wss:// and multiple occurrences', () => {
    const redacted = redactCdpUrls('a wss://h1/x b ws://h2/y c')
    expect(redacted).toBe('a ws://<redacted> b ws://<redacted> c')
  })

  it('leaves text without CDP URLs untouched', () => {
    expect(redactCdpUrls('✗ Wait timed out after 2000ms')).toBe('✗ Wait timed out after 2000ms')
  })

  it('handles a URL cut mid-way by truncation', () => {
    const cut = capBrowserOutput('boom ws://192.168.5.2:58686/devtools/browser/abcdef', 20)
    expect(redactCdpUrls(cut)).not.toContain('192.168.5.2')
  })
})
