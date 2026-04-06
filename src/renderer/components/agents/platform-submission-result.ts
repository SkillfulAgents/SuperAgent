export type PlatformSubmissionOutcome =
  | {
      kind: 'success'
      message: string
      showExternalLink: boolean
    }
  | {
      kind: 'pending'
      message: string
      showExternalLink: false
    }
  | {
      kind: 'error'
      message: string
      showExternalLink: false
    }

export function getPlatformSubmissionOutcome(prUrl: string): PlatformSubmissionOutcome {
  if (!prUrl.startsWith('platform:')) {
    return {
      kind: 'success',
      message: 'Pull request created successfully.',
      showExternalLink: true,
    }
  }

  const rawStatus = prUrl.slice('platform:'.length).trim().toLowerCase()

  switch (rawStatus) {
    case 'merged':
      return {
        kind: 'success',
        message: 'Changes submitted and merged successfully.',
        showExternalLink: false,
      }
    case 'pending':
    case 'submitted':
      return {
        kind: 'pending',
        message: 'Changes submitted for review.',
        showExternalLink: false,
      }
    case 'rejected':
    case 'blocked':
      return {
        kind: 'error',
        message: 'This upload was blocked by the platform. Review the skill changes and try again.',
        showExternalLink: false,
      }
    default:
      return {
        kind: 'error',
        message: `Platform submission failed with status "${rawStatus || 'unknown'}".`,
        showExternalLink: false,
      }
  }
}
