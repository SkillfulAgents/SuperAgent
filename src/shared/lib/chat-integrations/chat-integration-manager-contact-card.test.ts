import { IMessageConnector } from './imessage-connector'
import { MockChatClientConnector } from './mock-connector'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// `integrationCreated` is fire-and-forget from two create routes, so its guarantees
// are the ones nothing else can assert: it sends for iMessage only, it returns
// quietly when the integration/connector/agent is missing, it never throws, and
// it passes an EMPTY chatId — the gateway's create-a-chat fallback is what lets
// the card arrive before the user has ever messaged the agent.
// ---------------------------------------------------------------------------

vi.mock('@shared/lib/services/agent-integration-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/agent-integration-service')>()),
  getAgentIntegration: vi.fn(),
}))

vi.mock('@shared/lib/services/agent-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/agent-service')>()),
  getAgentRecord: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/error-reporting')>()),
  captureException: vi.fn(),
}))

import { getAgentIntegration } from '@shared/lib/services/agent-integration-service'
import { getAgentRecord } from '@shared/lib/services/agent-service'
import { chatIntegrationManager } from './chat-integration-manager'

const INT = 'int-contact-card'
const MINTED_ID = 'k7x9m2ab3c'
const originalHostPublicUrl = process.env.HOST_PUBLIC_URL

interface ManagerInternals {
  connections: Map<string, { connector: unknown }>
}
const mgr = chatIntegrationManager as unknown as ManagerInternals

const sendFile = vi.fn<(...args: unknown[]) => Promise<string>>()

async function registerConnector(): Promise<void> {
  const connector = (await getAgentIntegration(INT))?.provider === 'telegram' ? new MockChatClientConnector() : new IMessageConnector({ gatewayUrl: 'https://example.com', phoneNumber: '+15551234567', token: 'test' })
  connector.sendFile = sendFile
  mgr.connections.set(INT, { connector })
}

function mockIntegration(provider: string, name?: string | null): void {
  vi.mocked(getAgentIntegration).mockReturnValue({ provider, agentSlug: 'ada', name: name ?? null } as never)
}

function mockAgent(): void {
  vi.mocked(getAgentRecord).mockResolvedValue({ name: 'Ada', description: 'Triages inbox' } as never)
}

describe('integrationCreated', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mgr.connections.delete(INT)
    sendFile.mockResolvedValue('file-1')
    delete process.env.HOST_PUBLIC_URL
  })

  afterEach(async () => {
    if (originalHostPublicUrl === undefined) delete process.env.HOST_PUBLIC_URL
    else process.env.HOST_PUBLIC_URL = originalHostPublicUrl
  })

  it('sends only for iMessage', async () => {
    mockIntegration('telegram')
    await registerConnector()
    mockAgent()

    await chatIntegrationManager.integrationCreated(INT)

    expect(sendFile).not.toHaveBeenCalled()
  })

  it('returns quietly when the integration has no live connector', async () => {
    mockIntegration('imessage')
    mockAgent()

    await chatIntegrationManager.integrationCreated(INT)

    expect(sendFile).not.toHaveBeenCalled()
  })

  it('returns quietly when the agent is gone', async () => {
    mockIntegration('imessage')
    await registerConnector()
    vi.mocked(getAgentRecord).mockResolvedValue(null as never)

    await chatIntegrationManager.integrationCreated(INT)

    expect(sendFile).not.toHaveBeenCalled()
  })

  it('uploads the vCard with an empty chatId so the gateway can create the chat', async () => {
    mockIntegration('imessage')
    await registerConnector()
    mockAgent()

    await chatIntegrationManager.integrationCreated(INT)

    expect(sendFile).toHaveBeenCalledTimes(1)
    const [chatId, data, filename, caption] = sendFile.mock.calls[0]
    expect(chatId).toBe('')
    expect((data as Buffer).toString('utf8')).toContain('BEGIN:VCARD')
    expect(filename).toBe('Ada.vcf')
    expect(caption).toBeTruthy()
  })

  it('uses the Bot Name on the card when setup stored one, not the agent name', async () => {
    mockIntegration('imessage', 'Phone Ada')
    await registerConnector()
    mockAgent()

    await chatIntegrationManager.integrationCreated(INT)

    const [, data, filename] = sendFile.mock.calls[0]
    const vcf = (data as Buffer).toString('utf8')
    expect(vcf).toContain('FN:Phone Ada')
    expect(vcf).toContain('N:Phone Ada;;;;')
    expect(filename).toBe('Phone_Ada.vcf')
    expect(vcf).not.toMatch(/^FN:Ada\r?$/m)
  })

  it('strips path characters out of the agent name before it becomes a filename', async () => {
    mockIntegration('imessage')
    await registerConnector()
    vi.mocked(getAgentRecord).mockResolvedValue({ name: 'Sales/Support "bot"' } as never)

    await chatIntegrationManager.integrationCreated(INT)

    expect(sendFile.mock.calls[0][2]).toBe('Support__bot_.vcf')
  })

  it('links to the pretty display slug while the card UID keeps the minted id', async () => {
    process.env.HOST_PUBLIC_URL = 'https://app.example.com'
    vi.mocked(getAgentIntegration).mockReturnValue({ provider: 'imessage', agentSlug: MINTED_ID } as never)
    await registerConnector()
    mockAgent()

    await chatIntegrationManager.integrationCreated(INT)

    const vcf = (sendFile.mock.calls[0][1] as Buffer).toString('utf8')
    expect(vcf).toContain(`item1.URL:https://app.example.com/agents/ada-${MINTED_ID}`)
    expect(vcf).toContain(`UID:gamut-agent-${MINTED_ID}`)
  })

  it('never throws when the upload fails', async () => {
    mockIntegration('imessage')
    await registerConnector()
    mockAgent()
    sendFile.mockRejectedValue(new Error('gateway down'))

    await expect(chatIntegrationManager.integrationCreated(INT)).resolves.toBeUndefined()
  })
})
