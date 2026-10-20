import { describe, expect, it } from 'vitest'
import { sendPreviewFor, type HeldRequest, type SendPreviewRow } from './registry'

const preview = { kind: 'note', look: 'notes', title: 'Allow posting this note?', data: { text: 'hi' } }
const row = (decode: SendPreviewRow['decode']): SendPreviewRow => ({ toolkit: 'notes', method: 'POST', pathPattern: '/v1/*/notes', decode })
const held = (changes: Partial<HeldRequest> = {}): HeldRequest =>
  ({ toolkit: 'notes', method: 'post', targetPath: 'v1/me/notes', body: new TextEncoder().encode('{"text":"hi"}').buffer, ...changes })

describe('sendPreviewFor', () => {
  it('decodes a call its row matches by toolkit, method, and path', async () => {
    const seen: string[] = []
    const rows = [row(async (body) => { seen.push(body); return preview })]
    expect(await sendPreviewFor(held(), rows)).toEqual(preview)
    expect(seen).toEqual(['{"text":"hi"}'])
  })

  it('gives no preview when no row matches, the body is missing, or the row cannot read it', async () => {
    const reads = [row(async () => preview)]
    expect(await sendPreviewFor(held({ targetPath: 'v1/me/notes/1' }), reads)).toBeUndefined()
    expect(await sendPreviewFor(held({ toolkit: 'other' }), reads)).toBeUndefined()
    expect(await sendPreviewFor(held({ body: null }), reads)).toBeUndefined()
    expect(await sendPreviewFor(held(), [row(async () => undefined)])).toBeUndefined()
    expect(await sendPreviewFor(held(), [row(async () => { throw new Error('unreadable') })])).toBeUndefined()
  })
})
