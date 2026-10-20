/**
 * What a held send would deliver, decoded for the approval card. A service joins with one row. A call no row
 * matches, or a body its row cannot fully account for, gets no preview and the card shows the raw request.
 */
import { globMatch } from '../scope-matcher'
import type { SendPreview } from './schema'

/** One held request, as the proxy forwards it. */
export interface HeldRequest {
  toolkit: string
  method: string
  targetPath: string
  body: ArrayBuffer | null
  /** Saves a part of the message where the app can open it, and returns its path. `index` is its place in the message. */
  saveAttachment?: (name: string, bytes: Uint8Array, index: number) => Promise<string>
}

/** One send call a service makes, and how to read what it would deliver. */
export interface SendPreviewRow {
  toolkit: string
  method: string
  pathPattern: string
  /** Returns undefined, or throws, when it cannot account for the whole body. */
  decode: (body: string, saveAttachment: HeldRequest['saveAttachment']) => Promise<SendPreview | undefined>
}

export const SEND_PREVIEW_ROWS: readonly SendPreviewRow[] = []

/** The row for this call decodes it. Rows do not overlap yet, so the first match is the only one. */
export async function sendPreviewFor(
  { toolkit, method, targetPath, body, saveAttachment }: HeldRequest,
  rows: readonly SendPreviewRow[] = SEND_PREVIEW_ROWS,
): Promise<SendPreview | undefined> {
  if (!body) return undefined
  const path = '/' + targetPath
  const row = rows.find((candidate) => candidate.toolkit === toolkit && candidate.method === method.toUpperCase() && globMatch(candidate.pathPattern, path) !== null)
  if (!row) return undefined
  try {
    return await row.decode(new TextDecoder().decode(body), saveAttachment)
  } catch {
    return undefined
  }
}
