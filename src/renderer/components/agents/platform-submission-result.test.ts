import { describe, expect, it } from 'vitest'
import { getPlatformSubmissionOutcome } from './platform-submission-result'

describe('getPlatformSubmissionOutcome', () => {
  it('treats regular PR URLs as successful submissions', () => {
    expect(getPlatformSubmissionOutcome('https://github.com/SkillfulAgents/SuperAgent/pull/123')).toEqual({
      kind: 'success',
      message: 'Pull request created successfully.',
      showExternalLink: true,
    })
  })

  it('treats pending platform submissions as review states', () => {
    expect(getPlatformSubmissionOutcome('platform:pending')).toEqual({
      kind: 'pending',
      message: 'Changes submitted for review.',
      showExternalLink: false,
    })
  })

  it('treats submitted platform submissions as review states', () => {
    expect(getPlatformSubmissionOutcome('platform:submitted')).toEqual({
      kind: 'pending',
      message: 'Changes submitted for review.',
      showExternalLink: false,
    })
  })

  it('treats rejected platform submissions as errors', () => {
    expect(getPlatformSubmissionOutcome('platform:rejected')).toEqual({
      kind: 'error',
      message: 'This upload was blocked by the platform. Review the skill changes and try again.',
      showExternalLink: false,
    })
  })

  it('treats blocked platform submissions as errors', () => {
    expect(getPlatformSubmissionOutcome('platform:blocked')).toEqual({
      kind: 'error',
      message: 'This upload was blocked by the platform. Review the skill changes and try again.',
      showExternalLink: false,
    })
  })
})
