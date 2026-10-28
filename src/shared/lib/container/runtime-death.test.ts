import { describe, expect, it } from 'vitest'
import { inferOomSigkillFatal } from './runtime-death'

describe('inferOomSigkillFatal', () => {
  it('matches the container SIGKILL fatal result', () => {
    expect(
      inferOomSigkillFatal({
        fatal: true,
        error: 'The agent process was killed due to running out of memory. Try starting a new session.',
      }),
    ).toBe(true)
    expect(inferOomSigkillFatal({ fatal: true, error: 'killed by SIGKILL' })).toBe(true)
  })

  it('does not match SIGTERM or non-fatal errors', () => {
    expect(inferOomSigkillFatal({ fatal: true, error: 'The agent process was terminated unexpectedly.' })).toBe(
      false,
    )
    expect(inferOomSigkillFatal({ error: 'running out of memory' })).toBe(false)
  })
})
