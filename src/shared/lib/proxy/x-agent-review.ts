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

/** The links an agent card's "Always allow" menu offers. A list card names no target. */
export function xAgentAlwaysChoices(review: Pick<XAgentReview, 'operation' | 'targetAgentSlug'>): Array<{ operation: 'list' | 'read' | 'invoke'; targetSlug: string | null }> {
  if (requiresOneTimeXAgentReview(review)) return []
  const target = review.targetAgentSlug
  switch (review.operation) {
    case 'list': return [{ operation: 'list', targetSlug: null }]
    case 'read': return [{ operation: 'read', targetSlug: target }, { operation: 'read', targetSlug: null }]
    case 'invoke': return [{ operation: 'invoke', targetSlug: target }, { operation: 'invoke', targetSlug: null }, { operation: 'read', targetSlug: target }]
    case 'create': return []
  }
}

export function xAgentReviewAttachments(review: Pick<XAgentReview, 'fileTransfer' | 'attachments'>): string[] {
  return review.fileTransfer?.kind === 'send' ? review.fileTransfer.paths : review.attachments ?? []
}
