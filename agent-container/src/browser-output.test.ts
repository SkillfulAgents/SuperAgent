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
  const timeoutKill = {
    killed: true,
    signal: 'SIGTERM',
    code: null,
    stdout: '',
    stderr: '',
    message: `Command failed: agent-browser --cdp ws://192.168.5.2:58686/devtools/browser/abc eval ${script}`,
  }

  it('names the verb and the timeout when the exec layer killed the process, and never echoes the argv', () => {
    const text = describeExecFailure(timeoutKill, 'eval', 30_000)
    expect(text).toBe('agent-browser eval produced no result within 30s and was stopped.')
    expect(text).not.toContain('Command failed')
    expect(text).not.toContain('fetch(')
    expect(text).not.toContain('ws://')
  })

  it('keeps whatever the CLI wrote alongside a kill', () => {
    const text = describeExecFailure({ ...timeoutKill, stdout: '⏳ waiting for selector .done' }, 'wait', 30_000)
    expect(text).toContain('produced no result within 30s')
    expect(text).toContain('⏳ waiting for selector .done')
  })

  it('passes the CLI diagnostics through when they exist', () => {
    expect(describeExecFailure({ code: 1, stdout: '✗ Wait timed out after 25000ms', stderr: '' }, 'wait', 30_000))
      .toBe('✗ Wait timed out after 25000ms')
    expect(describeExecFailure({ code: 1, stdout: '', stderr: '✗ Unknown ref: e31' }, 'click', 30_000))
      .toBe('✗ Unknown ref: e31')
  })

  it('reports the exit code, not the command line, when nothing was written', () => {
    const text = describeExecFailure({ code: 'ENOENT', message: 'spawn agent-browser ENOENT' }, 'open', 30_000)
    expect(text).toBe('agent-browser open failed (exit ENOENT) without output.')
    expect(describeExecFailure({ code: 2, stdout: '', stderr: '' }, 'type', 30_000)).toContain('exit 2')
  })

  it('tells a buffer overflow kill from a timeout kill', () => {
    const text = describeExecFailure({ killed: true, signal: 'SIGTERM', message: 'stdout maxBuffer length exceeded' }, 'snapshot', 30_000)
    expect(text).toContain('exceeded the buffer limit')
    expect(text).not.toContain('within 30s')
  })
})
