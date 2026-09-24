import { z } from 'zod'

/** File disclosure is approved for one operation, independently of saved text permissions. */
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

export function requiresOneTimeXAgentReview(review: Pick<XAgentReview, 'operation' | 'fileTransfer' | 'attachments'> | undefined): boolean {
  return !!review && (review.operation === 'create' || !!review.fileTransfer || !!review.attachments?.length)
}

export function xAgentReviewAttachments(review: Pick<XAgentReview, 'fileTransfer' | 'attachments'>): string[] {
  return review.fileTransfer?.kind === 'send' ? review.fileTransfer.paths : review.attachments ?? []
}
