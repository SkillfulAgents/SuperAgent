import type { ReactNode } from 'react'
import type { SendPreview } from '@shared/lib/proxy/send-preview/schema'
import type { SendPreviewLook } from './define-look'

/** A look draws one kind the way its service does, so the approver recognizes the message. */
export const SEND_PREVIEW_LOOKS: Readonly<Record<string, SendPreviewLook>> = {}

/** An unknown look, or data its kind rejects, draws nothing, and the card shows the raw request alone. */
export function SendPreviewView({ preview, agentSlug }: { preview: SendPreview; agentSlug: string }): ReactNode {
  const look: SendPreviewLook | undefined = SEND_PREVIEW_LOOKS[preview.look]
  return look?.kind === preview.kind ? look.render(preview.data, agentSlug) : null
}
