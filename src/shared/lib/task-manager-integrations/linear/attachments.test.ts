import { describe, it, expect, vi, afterEach } from 'vitest'
import type { TaskAttachment } from '../attachment-schema'
import { LinearClient } from './client'
import { linearPublicationBody, uploadLinearAttachment } from './attachments'
const attachment: TaskAttachment = { id: crypto.randomUUID(), filename: 'graph.png', caption: 'Graph', contentType: 'image/png', size: 5 }
const upload = { success: true, uploadFile: { uploadUrl: 'https://storage.example/upload?signature=private', assetUrl: 'https://uploads.linear.app/graph.png', headers: [{ key: 'x-upload-header', value: 'required' }] } }
afterEach(() => { vi.unstubAllGlobals() })
describe('Linear file delivery', () => {
  it('uploads bytes with returned storage headers, without leaking the app bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ data: { fileUpload: upload } })).mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await uploadLinearAttachment(new LinearClient(undefined, 'secret-token'), attachment, Buffer.from('image'), () => {})).toBe(upload.uploadFile.assetUrl)
    const [url, options] = fetchMock.mock.calls[1]
    expect(url).toBe(upload.uploadFile.uploadUrl)
    expect(options.method).toBe('PUT')
    expect(Buffer.from(options.body).toString()).toBe('image')
    expect(options.headers.get('Authorization')).toBeNull()
    expect(options.headers.get('Content-Type')).toBe('image/png')
    expect(options.headers.get('x-upload-header')).toBe('required')
    expect(options.redirect).toBe('error')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({ contentType: 'image/png', filename: 'graph.png', size: 5 })
  })
  it('rejects failed HTTP uploads and scrubs signed URLs from transport errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ data: { fileUpload: upload } })).mockResolvedValueOnce(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(uploadLinearAttachment(new LinearClient(undefined, 'token'), attachment, Buffer.from('image'), () => {})).rejects.toThrow('503')
    fetchMock.mockResolvedValueOnce(Response.json({ data: { fileUpload: upload } })).mockRejectedValueOnce(new Error(upload.uploadFile.uploadUrl))
    await expect(uploadLinearAttachment(new LinearClient(undefined, 'token'), attachment, Buffer.from('image'), () => {})).rejects.toThrow('Linear attachment upload failed. Delivery will retry.')
  })
  it('checks cancellation between acquiring a signed URL and uploading', async () => {
    let active = true
    const fetchMock = vi.fn(async () => { active = false; return Response.json({ data: { fileUpload: upload } }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(uploadLinearAttachment(new LinearClient(undefined, 'token'), attachment, Buffer.from('image'), () => { if (!active) throw new Error('Cancelled') })).rejects.toThrow('Cancelled')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('renders images inline and other files as links with escaped labels', () => {
    const body = linearPublicationBody({ id: crypto.randomUUID(), kind: 'response', body: 'Results', attachments: [
      { ...attachment, assetUrl: upload.uploadFile.assetUrl },
      { ...attachment, contentType: 'text/csv', filename: 'data[1].csv', caption: undefined, assetUrl: 'https://uploads.linear.app/data.csv' },
    ] })
    expect(body).toBe('Results\n\n![Graph](<https://uploads.linear.app/graph.png>)\n\nGraph\n\n[data\\[1\\].csv](<https://uploads.linear.app/data.csv>)')
    expect(() => linearPublicationBody({ id: crypto.randomUUID(), kind: 'response', body: 'Missing', attachments: [attachment] })).toThrow('not finished uploading')
  })
})
