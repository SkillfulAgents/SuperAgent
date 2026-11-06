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

export function xAgentReviewAttachments(review: Pick<XAgentReview, 'fileTransfer' | 'attachments'>): string[] {
  return review.fileTransfer?.kind === 'send' ? review.fileTransfer.paths : review.attachments ?? []
}
