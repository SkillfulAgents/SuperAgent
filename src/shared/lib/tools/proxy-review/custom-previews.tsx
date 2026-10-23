import { useEffect, useState, type ReactNode } from 'react'
import { gmailDraftCreateCustomPreview, gmailDraftUpdateCustomPreview, gmailSendCustomPreview } from './gmail-send'

/** Draws one call from the request body the card already has, the way its service shows it. */
export interface CustomPreview {
  toolkit: string
  method: string
  path: RegExp
  /** The card's title for this call, in place of the endpoint description, once the body reads. */
  title: string
  /** The call as its service shows it. Undefined when the body does not read, so the card keeps its title and shows the raw request alone. */
  read: (requestBody: string) => Promise<ReactNode | undefined>
}

export const CUSTOM_PREVIEWS: readonly CustomPreview[] = [gmailSendCustomPreview, gmailDraftCreateCustomPreview, gmailDraftUpdateCustomPreview]

export function customPreviewFor(toolkit: string, method: string, targetPath: string): CustomPreview | undefined {
  return CUSTOM_PREVIEWS.find((preview) => preview.toolkit === toolkit && preview.method === method.toUpperCase() && preview.path.test(targetPath))
}

/** The matching custom preview's title and drawing, once it has read this body. */
export function useCustomPreview(toolkit: string, method: string, targetPath: string, requestBody: string | undefined): { title: string; preview: ReactNode } | undefined {
  const customPreview = customPreviewFor(toolkit, method, targetPath)
  const [read, setRead] = useState<{ customPreview: CustomPreview; requestBody: string; preview: ReactNode }>()
  useEffect(() => {
    if (!customPreview || !requestBody) return
    let current = true
    customPreview.read(requestBody).then((preview) => { if (current && preview) setRead({ customPreview, requestBody, preview }) }, () => {})
    return () => { current = false }
  }, [customPreview, requestBody])
  // A read of an earlier body or call does not describe this one.
  return read && read.customPreview === customPreview && read.requestBody === requestBody ? { title: read.customPreview.title, preview: read.preview } : undefined
}
