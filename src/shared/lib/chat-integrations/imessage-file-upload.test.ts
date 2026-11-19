import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { expect, it, vi } from 'vitest'
import { IMessageConnector } from './imessage-connector'
import { requestGatewayUpload, sendGatewayMessage } from './imessage-gateway-client'
import { captureException } from '@shared/lib/error-reporting'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('./imessage-gateway-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./imessage-gateway-client')>()),
  requestGatewayUpload: vi.fn(),
  sendGatewayMessage: vi.fn(),
}))

it('uploads a contact card with signed headers using the app’s Undici dispatcher', async () => {
  const card = Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Text Agent 🤖\r\nEND:VCARD\r\n')
  let received: {
    body: Buffer
    contentLength: string | undefined
    contentType: string | undefined
    metadata: string | string[] | undefined
    lengthHeaderCount: number
  } | undefined
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received = {
        body: Buffer.concat(chunks),
        contentLength: request.headers['content-length'],
        contentType: request.headers['content-type'],
        metadata: request.headers['x-amz-meta-contact'],
        lengthHeaderCount: request.rawHeaders.filter((_, index) => index % 2 === 0)
          .filter(name => name.toLowerCase() === 'content-length').length,
      }
      response.writeHead(200).end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const previousDispatcher = getGlobalDispatcher()
  const dispatcher = new Agent()
  setGlobalDispatcher(dispatcher)
  try {
    const { port } = server.address() as AddressInfo
    vi.mocked(requestGatewayUpload).mockResolvedValue({
      attachmentId: 'contact-attachment',
      uploadUrl: `http://127.0.0.1:${port}/contact.vcf`,
      downloadUrl: 'https://example.com/contact.vcf',
      requiredHeaders: {
        'Content-Length': String(card.length),
        'Content-Type': 'text/vcard',
        'x-amz-meta-contact': 'signed-metadata',
      },
    })
    vi.mocked(sendGatewayMessage).mockResolvedValue({ messageId: 'contact-message', chatId: 'recipient-chat' })
    const connector = new IMessageConnector({
      gatewayUrl: 'https://imessage.example.com', phoneNumber: '+15555550100', token: 'test-token',
    })
    Object.assign(connector, { mode: 'webhooks' })

    await connector.sendFile('recipient-chat', card, 'contact.vcf', 'Save this contact')

    expect(received).toEqual({
      body: card,
      contentLength: String(card.length),
      contentType: 'text/vcard',
      metadata: 'signed-metadata',
      lengthHeaderCount: 1,
    })
    expect(sendGatewayMessage).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      chatId: 'recipient-chat',
      parts: [{ type: 'media', attachmentId: 'contact-attachment' }, { type: 'text', value: 'Save this contact' }],
    })
    expect(captureException).not.toHaveBeenCalled()
  } finally {
    setGlobalDispatcher(previousDispatcher)
    await dispatcher.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
