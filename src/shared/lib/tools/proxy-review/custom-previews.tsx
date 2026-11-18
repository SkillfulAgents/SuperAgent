import { useEffect, useState, type ReactNode } from 'react'
import { gmailDraftCreateCustomPreview, gmailDraftUpdateCustomPreview, gmailSendCustomPreview } from './gmail-send'
import { gitHubBlobCustomPreview, gitHubFileCommitCustomPreview, gitHubTreeCustomPreview } from './github'

/** Draws one call from the request body the card already has, the way its service shows it. */
export interface CustomPreview {
  toolkit: string
  method: string
  path: RegExp
  /** The card's title for this call, in place of the endpoint description, once the body reads. */
  title: string | ((targetPath: string) => ReactNode)
  /** The call as its service shows it, or null for this title alone. Undefined when the body does not read, so the card keeps the endpoint title. */
  read: (requestBody: string) => Promise<ReactNode | undefined>
}

export const CUSTOM_PREVIEWS: readonly CustomPreview[] = [gmailSendCustomPreview, gmailDraftCreateCustomPreview, gmailDraftUpdateCustomPreview, gitHubBlobCustomPreview, gitHubFileCommitCustomPreview, gitHubTreeCustomPreview]

export function customPreviewFor(toolkit: string, method: string, targetPath: string): CustomPreview | undefined {
  return CUSTOM_PREVIEWS.find((preview) => preview.toolkit === toolkit && preview.method === method.toUpperCase() && preview.path.test(targetPath))
}

/** The matching custom preview's title and drawing, once it has read this body. */
export function useCustomPreview(toolkit: string, method: string, targetPath: string, requestBody: string | undefined): { title: ReactNode; preview: ReactNode } | undefined {
  const customPreview = customPreviewFor(toolkit, method, targetPath)
  const [read, setRead] = useState<{ customPreview: CustomPreview; requestBody: string; preview: ReactNode }>()
  useEffect(() => {
    if (!customPreview || !requestBody) return
    let current = true
    customPreview.read(requestBody).then((preview) => { if (current && preview !== undefined) setRead({ customPreview, requestBody, preview }) }, () => {})
    return () => { current = false }
  }, [customPreview, requestBody])
  // A read of an earlier body or call does not describe this one.
  if (!read || read.customPreview !== customPreview || read.requestBody !== requestBody) return undefined
  const { title } = read.customPreview
  return { title: typeof title === 'string' ? title : title(targetPath), preview: read.preview }
}

/** A name from the request, set off in the title the way the endpoint titles set off code. Each wrapped line keeps its own chip. */
export function TitleCode({ children }: { children?: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-px font-mono text-[0.9em] [box-decoration-break:clone] [-webkit-box-decoration-break:clone] whitespace-pre-wrap">{children}</code>
}
