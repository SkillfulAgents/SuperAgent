import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// `sendContactCard` is fire-and-forget from two create routes, so its guarantees
// are the ones nothing else can assert: it sends for iMessage only, it returns
// quietly when the integration/connector/agent is missing, it never throws, and
// it passes an EMPTY chatId — the gateway's create-a-chat fallback is what lets
// the card arrive before the user has ever messaged the agent.
// ---------------------------------------------------------------------------

vi.mock('@shared/lib/services/chat-integration-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/chat-integration-service')>()),
  getChatIntegration: vi.fn(),
}))

vi.mock('@shared/lib/services/agent-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/agent-service')>()),
  getAgent: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/error-reporting')>()),
  captureException: vi.fn(),
}))

import { getChatIntegration } from '@shared/lib/services/chat-integration-service'
import { getAgent } from '@shared/lib/services/agent-service'
import { chatIntegrationManager } from './chat-integration-manager'

const INT = 'int-contact-card'
const MINTED_ID = 'k7x9m2ab3c'
const originalHostPublicUrl = process.env.HOST_PUBLIC_URL

interface ManagerInternals {
  connections: Map<string, { connector: unknown }>
}
const mgr = chatIntegrationManager as unknown as ManagerInternals

const sendFile = vi.fn<(...args: unknown[]) => Promise<string>>()

function registerConnector(): void {
  mgr.connections.set(INT, { connector: { sendFile } })
}

function mockIntegration(provider: string): void {
  vi.mocked(getChatIntegration).mockReturnValue({ provider, agentSlug: 'ada' } as never)
}

function mockAgent(): void {
  vi.mocked(getAgent).mockResolvedValue({ frontmatter: { name: 'Ada', description: 'Triages inbox' } } as never)
}

describe('sendContactCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mgr.connections.delete(INT)
    sendFile.mockResolvedValue('file-1')
    delete process.env.HOST_PUBLIC_URL
  })

  afterEach(() => {
    if (originalHostPublicUrl === undefined) delete process.env.HOST_PUBLIC_URL
    else process.env.HOST_PUBLIC_URL = originalHostPublicUrl
  })

  it('sends only for iMessage', async () => {
    mockIntegration('telegram')
    registerConnector()
    mockAgent()

    await chatIntegrationManager.sendContactCard(INT)

    expect(sendFile).not.toHaveBeenCalled()
  })

  it('returns quietly when the integration has no live connector', async () => {
    mockIntegration('imessage')
    mockAgent()

    await chatIntegrationManager.sendContactCard(INT)

    expect(sendFile).not.toHaveBeenCalled()
  })

  it('returns quietly when the agent is gone', async () => {
    mockIntegration('imessage')
    registerConnector()
    vi.mocked(getAgent).mockResolvedValue(null as never)

    await chatIntegrationManager.sendContactCard(INT)

    expect(sendFile).not.toHaveBeenCalled()
  })

  it('uploads the vCard with an empty chatId so the gateway can create the chat', async () => {
    mockIntegration('imessage')
    registerConnector()
    mockAgent()

    await chatIntegrationManager.sendContactCard(INT)

    expect(sendFile).toHaveBeenCalledTimes(1)
    const [chatId, data, filename, caption] = sendFile.mock.calls[0]
    expect(chatId).toBe('')
    expect((data as Buffer).toString('utf8')).toContain('BEGIN:VCARD')
    expect(filename).toBe('Ada.vcf')
    expect(caption).toBeTruthy()
  })

  it('strips path characters out of the agent name before it becomes a filename', async () => {
    mockIntegration('imessage')
    registerConnector()
    vi.mocked(getAgent).mockResolvedValue({ frontmatter: { name: 'Sales/Support "bot"' } } as never)

    await chatIntegrationManager.sendContactCard(INT)

    expect(sendFile.mock.calls[0][2]).toBe('Support__bot_.vcf')
  })

  it('links to the pretty display slug while the card UID keeps the minted id', async () => {
    process.env.HOST_PUBLIC_URL = 'https://app.example.com'
    vi.mocked(getChatIntegration).mockReturnValue({ provider: 'imessage', agentSlug: MINTED_ID } as never)
    registerConnector()
    mockAgent()

    await chatIntegrationManager.sendContactCard(INT)

    const vcf = (sendFile.mock.calls[0][1] as Buffer).toString('utf8')
    expect(vcf).toContain(`item1.URL:https://app.example.com/agents/ada-${MINTED_ID}`)
    expect(vcf).toContain(`UID:gamut-agent-${MINTED_ID}`)
  })

  it('never throws when the upload fails', async () => {
    mockIntegration('imessage')
    registerConnector()
    mockAgent()
    sendFile.mockRejectedValue(new Error('gateway down'))

    await expect(chatIntegrationManager.sendContactCard(INT)).resolves.toBeUndefined()
  })
})
