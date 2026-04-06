import { describe, expect, it } from 'vitest'
import { getPlatformSubmissionRejectedMessage } from './platform-submission'

describe('getPlatformSubmissionRejectedMessage', () => {
  it('ignores regular PR URLs', () => {
    expect(getPlatformSubmissionRejectedMessage('https://github.com/SkillfulAgents/SuperAgent/pull/123')).toBeNull()
  })

  it('ignores non-rejected platform statuses', () => {
    expect(getPlatformSubmissionRejectedMessage('platform:submitted')).toBeNull()
    expect(getPlatformSubmissionRejectedMessage('platform:merged')).toBeNull()
  })

  it('returns a message for rejected platform submissions', () => {
    expect(getPlatformSubmissionRejectedMessage('platform:rejected')).toBe(
      'This upload was rejected by the platform. Review the changes and try again.'
    )
  })
})
