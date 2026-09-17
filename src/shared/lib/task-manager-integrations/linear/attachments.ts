import type { TaskAttachment } from '../attachment-schema'
import type { TaskPublication } from '../types'
import type { LinearClient } from './client'
import { linearFileUploadSchema } from './upload-schema'

export async function uploadLinearAttachment(client: LinearClient, attachment: TaskAttachment, bytes: Buffer, assertActive: () => void): Promise<string> {
  const { fileUpload } = await client.withGuard(assertActive).request(
    `mutation($contentType:String!,$filename:String!,$size:Int!){fileUpload(contentType:$contentType,filename:$filename,size:$size){success uploadFile{uploadUrl assetUrl headers{key value}}}}`,
    { contentType: attachment.contentType, filename: attachment.filename, size: bytes.length }, linearFileUploadSchema,
  )
  if (!fileUpload.success || !fileUpload.uploadFile) throw new Error('Linear did not authorize the attachment upload')
  const { uploadUrl, assetUrl, headers: uploadHeaders } = fileUpload.uploadFile
  const headers = new Headers({ 'Content-Type': attachment.contentType, 'Cache-Control': 'public, max-age=31536000' })
  for (const header of uploadHeaders) headers.set(header.key, header.value)
  assertActive()
  // Signed storage headers only: the Linear OAuth bearer never leaves its API.
  let response: Response
  try {
    response = await fetch(uploadUrl, { method: 'PUT', headers, body: new Uint8Array(bytes), redirect: 'error', signal: AbortSignal.timeout(60000) })
  } catch { throw new Error('Linear attachment upload failed. Delivery will retry.') }
  if (!response.ok) throw new Error(`Linear attachment upload failed (${response.status}). Delivery will retry.`)
  assertActive()
  return assetUrl
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()<>!|~]/g, '\\$&')
}

/** Compose after summarization; the model never has to preserve storage URLs. */
export function linearPublicationBody(publication: TaskPublication): string {
  const parts = [publication.body]
  for (const attachment of publication.attachments ?? []) {
    if (!attachment.assetUrl) throw new Error('Attachment has not finished uploading')
    const url = attachment.assetUrl.replace(/[<>\s]/g, character => encodeURIComponent(character))
    const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.contentType)
    const label = escapeMarkdown(image ? attachment.caption || attachment.filename : attachment.filename)
    parts.push(`${image ? '!' : ''}[${label}](<${url}>)`)
    if (attachment.caption) parts.push(escapeMarkdown(attachment.caption))
  }
  return parts.join('\n\n')
}
