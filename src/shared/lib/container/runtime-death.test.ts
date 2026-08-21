import { describe, expect, it } from 'vitest'
import { buildRecoveryPrompt, inferOomSigkillFatal } from './runtime-death'

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

describe('buildRecoveryPrompt', () => {
  it('appends a coalesced user message onto the same resume', () => {
    expect(buildRecoveryPrompt('Resume the turn.')).toBe('Resume the turn.')
    expect(buildRecoveryPrompt('Resume the turn.', '  keep going  ')).toBe(
      'Resume the turn.\n\nThe user also sent:\nkeep going',
    )
  })
})
