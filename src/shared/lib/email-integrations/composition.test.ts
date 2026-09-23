import { beforeEach, expect, it, vi } from 'vitest'
import { composeEmailReply } from './composition'
import { emailMessageSchema } from './config-schema'
const model = vi.hoisted(() => vi.fn())
vi.mock('../config/settings', () => ({ getEffectiveModels: () => ({ summarizerModel: 'configured-summary' }) }))
vi.mock('../llm-provider', () => ({ resolveActiveProviderModel: (model: string) => model }))
vi.mock('../llm-provider/helpers', () => ({ getConfiguredLlmClient: () => ({}), createSummarizerText: model }))
const mail = emailMessageSchema.parse({ id: 'm', mailboxId: 'b', threadId: 't', direction: 'inbound', messageId: null, replyToMessageId: null, from: 'a@company.com', to: ['agent@company.com'], cc: [], bcc: [], replyTo: [], subject: 'Report?', text: 'Send the report', html: null, status: 'received', createdAt: 1 })
beforeEach(() => model.mockReset())
it('uses the configured model with structured output and all answer blocks', async () => {
  model.mockResolvedValue(JSON.stringify({ action: 'send', text: 'Your report is ready.' }))
  expect(await composeEmailReply(mail, [mail], ['Your report is ready.', 'Just the monitor.'], 1)).toEqual({ action: 'send', text: 'Your report is ready.' })
  const request = model.mock.calls[0][1]
  expect(request.model).toBe('configured-summary')
  expect(JSON.parse(request.messages[0].content)).toMatchObject({ assistantTextBlocks: ['Your report is ready.', 'Just the monitor.'], attachmentCount: 1 })
  expect(request.output_config.format.type).toBe('json_schema')
  expect(model.mock.calls[0][2]).toBeInstanceOf(AbortSignal)
})
it('allows suppressing a monitor-only follow-up without attachments', async () => {
  model.mockResolvedValue('{"action":"none","text":""}')
  expect((await composeEmailReply(mail, [], ['No new results.'], 0)).action).toBe('none')
})
it.each([null, 'invalid JSON', '{"action":"send","text":""}', '{"action":"send","text":"Hi","to":["attacker@example.com"]}'])('rejects unusable or recipient-modifying output: %s', async result => {
  model.mockResolvedValue(result)
  await expect(composeEmailReply(mail, [], ['Answer'], 0)).rejects.toThrow()
})
it('does not silently drop selected attachments', async () => {
  model.mockResolvedValue('{"action":"none","text":""}')
  await expect(composeEmailReply(mail, [], ['Here is the report.'], 1)).rejects.toThrow('omitted selected attachments')
})

it('does not mix a newer inbound request into a reply already being composed', async () => {
  model.mockResolvedValue('{"action":"send","text":"Your report is ready."}')
  const newer = { ...mail, id: 'newer', createdAt: 2, text: 'Unrelated next request' }
  await composeEmailReply(mail, [mail, newer], ['Your report is ready.'], 0)
  expect(JSON.parse(model.mock.calls[0][1].messages[0].content).emailChain).toHaveLength(1)
})
