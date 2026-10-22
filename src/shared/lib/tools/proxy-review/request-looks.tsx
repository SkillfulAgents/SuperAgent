import type { ReactNode } from 'react'
import { gmailSendLook } from './gmail-send'

/** Draws one call from the request body the card already has, the way its service shows it. */
export interface RequestLook {
  toolkit: string
  method: string
  path: RegExp
  /** The card's title for this call, in place of the endpoint description. */
  title: string
  /** Draws nothing when it cannot read the body, so the card shows the raw request alone. */
  Look: (props: { requestBody: string }) => ReactNode
}

export const REQUEST_LOOKS: readonly RequestLook[] = [gmailSendLook]

export function requestLookFor(toolkit: string, method: string, targetPath: string): RequestLook | undefined {
  return REQUEST_LOOKS.find((look) => look.toolkit === toolkit && look.method === method.toUpperCase() && look.path.test(targetPath))
}
