import { describe, it, expect } from 'vitest'
import { capBrowserOutput, redactCdpUrls, describeExecFailure, MAX_BROWSER_ERROR_CHARS } from './browser-output'

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

describe('describeExecFailure', () => {
  const script = '(async () => { const rows = await fetch("/api/rows").then(r => r.json()); return rows.length })()'
  const argvMessage = `Command failed: agent-browser --cdp ws://192.168.5.2:58686/devtools/browser/abc eval ${script}`
  const NOT_KNOWN = 'whether the page-side action completed is not known'

  it('reports the measured duration of an exec-timeout kill, never the argv, and does not claim the page stopped', () => {
    const text = describeExecFailure({ killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '', message: argvMessage }, 'eval', 30_012)
    expect(text).toBe(`agent-browser eval produced no result within 30012 ms and was stopped. The CLI call was stopped; ${NOT_KNOWN}.`)
    expect(text).not.toContain('Command failed')
    expect(text).not.toContain('fetch(')
    expect(text).not.toContain('ws://')
  })

  it('reports an external signal as a termination after the measured time, not as a timeout', () => {
    // review: a process killed externally after 13 ms was reported as exceeding 30 seconds
    const text = describeExecFailure({ killed: false, signal: 'SIGTERM', code: null, stdout: '', stderr: '', message: argvMessage }, 'eval', 13)
    expect(text).toBe(`agent-browser eval was terminated by SIGTERM after 13 ms with no output. The CLI call was stopped; ${NOT_KNOWN}.`)
    expect(text).not.toContain('within')
    expect(text).not.toContain('30')
  })

  it('keeps whatever the CLI wrote alongside a kill', () => {
    const text = describeExecFailure({ killed: true, signal: 'SIGTERM', stdout: '⏳ waiting for selector .done', message: argvMessage }, 'wait', 30_004)
    expect(text).toContain('produced no result within 30004 ms')
    expect(text).toContain('⏳ waiting for selector .done')
  })

  it('passes the CLI diagnostics through when they exist', () => {
    expect(describeExecFailure({ code: 1, stdout: '✗ Wait timed out after 25000ms', stderr: '' }, 'wait', 25_070))
      .toBe('✗ Wait timed out after 25000ms')
    expect(describeExecFailure({ code: 1, stdout: '', stderr: '✗ Unknown ref: e31' }, 'click', 40))
      .toBe('✗ Unknown ref: e31')
  })

  it('reports the exit code, not the command line, when nothing was written', () => {
    const text = describeExecFailure({ code: 'ENOENT', message: 'spawn agent-browser ENOENT' }, 'open', 5)
    expect(text).toBe('agent-browser open failed (exit ENOENT) without output.')
    expect(describeExecFailure({ code: 2, stdout: '', stderr: '' }, 'type', 90)).toContain('exit 2')
  })

  it('tells a buffer overflow kill from a timeout kill', () => {
    const text = describeExecFailure({ killed: true, signal: 'SIGTERM', message: 'stdout maxBuffer length exceeded' }, 'snapshot', 1_200)
    expect(text).toContain('exceeded the buffer limit')
    expect(text).toContain('after 1200 ms')
    expect(text).not.toContain('within')
  })
})
