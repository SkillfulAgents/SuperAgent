import type { ApiSkillsetConfig } from '@shared/lib/types/api'

type PublishMode = ApiSkillsetConfig['publishMode']
type PublishTarget = 'skill' | 'agent template'

type PublishDialogCopy = {
  descriptionSuffix: string
  titleLabel: string
  submitButton: string
  pendingButton: string
}

type SubmitDialogCopy = {
  title: string
  description: string
  titleLabel: string
  submitButton: string
  pendingButton: string
}

export function isPullRequestPublishMode(mode: PublishMode): boolean {
  return mode === 'pull_request'
}

export function getReviewActionLabel(mode: PublishMode): string {
  return isPullRequestPublishMode(mode) ? 'Open PR' : 'Push'
}

export function getPublishDialogCopy(
  _target: PublishTarget,
  mode: PublishMode,
): PublishDialogCopy {
  if (mode === 'pull_request') {
    return {
      descriptionSuffix: 'via a pull request',
      titleLabel: 'PR Title',
      submitButton: 'Create Pull Request',
      pendingButton: 'Publishing...',
    }
  }

  return {
    descriptionSuffix: 'for review',
    titleLabel: 'Title',
    submitButton: 'Submit Changes',
    pendingButton: 'Submitting...',
  }
}

export function getSubmitDialogCopy(
  target: PublishTarget,
  mode: PublishMode,
): SubmitDialogCopy {
  if (mode === 'pull_request') {
    return {
      title: 'Open Pull Request',
      description: `Submit your local ${target} changes back to the skillset repository.`,
      titleLabel: 'PR Title',
      submitButton: 'Create Pull Request',
      pendingButton: 'Creating PR...',
    }
  }

  return {
    title: 'Push Changes',
    description: `Push your local ${target} changes back to the skillset.`,
    titleLabel: 'Title',
    submitButton: 'Push Changes',
    pendingButton: 'Pushing...',
  }
}
