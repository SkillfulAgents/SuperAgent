import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs'
import { BaseContainerClient } from './base-container-client'
import type { ContainerConfig } from './types'

// ============================================================================
// SUP-211 — Container mount volume specs must be shell-escaped so that a
// user-controlled host path can never trigger command substitution / variable
// expansion when start() interpolates the flag into a single command string
// run through child_process.exec (a real /bin/sh -c on Unix).
//
// Before the fix, buildVolumeFlag() wrapped the spec in RAW double quotes
// (`"host:container"`). Inside Unix double quotes, $(...), backticks and $VAR
// still expand — so `/tmp/a$(touch /tmp/pwn)b` would execute `touch` on the
// host. The fix wraps the spec in single quotes (Unix) with embedded single
// quotes escaped as '\'' so the whole spec is an inert literal.
// ============================================================================

/** Minimal concrete subclass so we can call the public buildVolumeFlag(). */
class TestContainerClient extends BaseContainerClient {
  protected getRunnerCommand(): string {
    return 'docker'
  }
}

function makeClient(): TestContainerClient {
  return new TestContainerClient({ agentId: 'sup211' } as ContainerConfig)
}

// Marker files the malicious command-substitution payloads would create if the
// shell ever evaluated the spec. We assert they never appear.
const PWN_CMD_SUB = '/tmp/superagent-volume-pwn'
const PWN_QUOTE = '/tmp/superagent-volume-pwn2'

describe('SUP-211 buildVolumeFlag shell escaping', () => {
  afterEach(() => {
    // Clean up any marker file in case a regression let the payload run.
    for (const f of [PWN_CMD_SUB, PWN_QUOTE]) {
      try { fs.unlinkSync(f) } catch { /* never created — expected */ }
    }
  })

  it('produces a flag that does NOT execute command substitution via a real shell', () => {
    if (process.platform === 'win32') return // shell-execution assertion is Unix-only

    // Pre-condition: the marker must not already exist.
    expect(fs.existsSync(PWN_CMD_SUB)).toBe(false)

    const malicious = `/tmp/a$(touch ${PWN_CMD_SUB})b`
    const flag = makeClient().buildVolumeFlag(malicious, '/work')

    // Behavioral / end-to-end: feed the flag to a real /bin/sh exactly the way
    // start() does (interpolated, unquoted, into a command string). `printf %s`
    // echoes its argument back so we can compare against the literal spec.
    const stdout = execSync(`printf %s ${flag}`, { shell: '/bin/sh' }).toString()

    expect(stdout).toBe(`/tmp/a$(touch ${PWN_CMD_SUB})b:/work`)
    // The command substitution must NOT have run.
    expect(fs.existsSync(PWN_CMD_SUB)).toBe(false)
  })

  it('survives a single-quote in the host path (naive-quoting regression)', () => {
    if (process.platform === 'win32') return

    expect(fs.existsSync(PWN_QUOTE)).toBe(false)

    // A single quote would break out of a naive single-quoted region and
    // re-enable expansion unless embedded quotes are escaped as '\''.
    const malicious = `/tmp/a'$(touch ${PWN_QUOTE})'b`
    const flag = makeClient().buildVolumeFlag(malicious, '/work')

    const stdout = execSync(`printf %s ${flag}`, { shell: '/bin/sh' }).toString()

    expect(stdout).toBe(`/tmp/a'$(touch ${PWN_QUOTE})'b:/work`)
    expect(fs.existsSync(PWN_QUOTE)).toBe(false)
  })

  it('structurally wraps the whole spec in single quotes on Unix', () => {
    if (process.platform === 'win32') return

    const flag = makeClient().buildVolumeFlag(`/tmp/a$(touch ${PWN_CMD_SUB})b`, '/work')

    // Fully single-quoted: any $(...)/backtick/$VAR is inside the quoted literal.
    expect(flag.startsWith("'")).toBe(true)
    expect(flag.endsWith("'")).toBe(true)
    // Exact expected escaping: no embedded single quote in this path, so the
    // spec passes through verbatim inside one pair of single quotes.
    expect(flag).toBe(`'/tmp/a$(touch ${PWN_CMD_SUB})b:/work'`)
  })

  it('escapes embedded single quotes as the POSIX \'\\\'\' sequence', () => {
    if (process.platform === 'win32') return

    const flag = makeClient().buildVolumeFlag(`/tmp/it's`, '/work')
    expect(flag).toBe(`'/tmp/it'\\''s:/work'`)
  })

  it('preserves an ordinary path as a single shell token', () => {
    if (process.platform === 'win32') return

    const flag = makeClient().buildVolumeFlag('/home/user/project', '/workspace')
    const stdout = execSync(`printf %s ${flag}`, { shell: '/bin/sh' }).toString()
    expect(stdout).toBe('/home/user/project:/workspace')
  })
})
