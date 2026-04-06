export function getPlatformSubmissionRejectedMessage(prUrl: string): string | null {
  if (!prUrl.startsWith('platform:')) return null

  const rawStatus = prUrl.slice('platform:'.length).trim().toLowerCase()
  if (rawStatus !== 'rejected') return null

  return 'This upload was rejected by the platform. Review the changes and try again.'
}
