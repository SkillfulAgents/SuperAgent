import type { ReactNode } from 'react'
import { gmailSendCustomPreview } from './gmail-send'

/** Draws one call from the request body the card already has, the way its service shows it. */
export interface CustomPreview {
  toolkit: string
  method: string
  path: RegExp
  /** The card's title for this call, in place of the endpoint description. */
  title: string
  /** Draws nothing when it cannot read the body, so the card shows the raw request alone. */
  Preview: (props: { requestBody: string }) => ReactNode
}

export const CUSTOM_PREVIEWS: readonly CustomPreview[] = [gmailSendCustomPreview]

export function customPreviewFor(toolkit: string, method: string, targetPath: string): CustomPreview | undefined {
  return CUSTOM_PREVIEWS.find((preview) => preview.toolkit === toolkit && preview.method === method.toUpperCase() && preview.path.test(targetPath))
}
