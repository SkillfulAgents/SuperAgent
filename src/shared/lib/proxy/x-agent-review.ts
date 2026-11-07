import { z } from 'zod'

export const xAgentFileTransferSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('send'), paths: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('download'), filename: z.string().min(1) }),
])
export type XAgentFileTransfer = z.infer<typeof xAgentFileTransferSchema>

export type XAgentReview = {
  targetAgentSlug: string
  targetAgentName: string
  operation: 'list' | 'read' | 'invoke' | 'create'
  preview?: string
  fileTransfer?: XAgentFileTransfer
  /** Compatibility with pending reviews created by an older host. */
  attachments?: string[]
}

export function requiresOneTimeXAgentReview(review: Pick<XAgentReview, 'operation'> | undefined): boolean {
  return review?.operation === 'create'
}

/** A read or message request names another agent, so allowing it needs access to that agent too. */
export function xAgentReviewNamesTarget(review: Pick<XAgentReview, 'operation'> | undefined): boolean {
  return review?.operation === 'read' || review?.operation === 'invoke'
}

/** In a team workspace only someone who uses both agents can allow a read or a message, and `lacking` names the agents they don't use. */
export function xAgentAllowState({ isAuthMode, rolesReady, usesCaller, usesTarget, review }: {
  isAuthMode: boolean
  rolesReady: boolean
  usesCaller: boolean
  usesTarget: boolean
  review: Pick<XAgentReview, 'operation' | 'targetAgentSlug' | 'targetAgentName'>
}): { canAllow: boolean; lacking: string[] } {
  const canAllow = !isAuthMode || !xAgentReviewNamesTarget(review) || (rolesReady && usesCaller && usesTarget)
  if (canAllow || !rolesReady) return { canAllow, lacking: [] }
  const lacking = [usesCaller ? '' : 'this agent', usesTarget ? '' : review.targetAgentName.trim() || review.targetAgentSlug]
  return { canAllow, lacking: lacking.filter((name) => name !== '') }
}

export function xAgentReviewAttachments(review: Pick<XAgentReview, 'fileTransfer' | 'attachments'>): string[] {
  return review.fileTransfer?.kind === 'send' ? review.fileTransfer.paths : review.attachments ?? []
}
