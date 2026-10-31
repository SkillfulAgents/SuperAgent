import { describe, it, expect, vi } from 'vitest'
import type { ToolOutcome } from './chat-agent-integration'
import { SlackConnector, MAX_TOOL_GROUP_CARDS, toolGroupBlocks, toolGroupText } from './slack-connector'

function makeConnector() {
  const connector = new SlackConnector({ botToken: 'xoxb-fake', appToken: 'xapp-fake' })
  let ts = 0
  const postMessage = vi.fn(async (_req: any) => ({ ok: true, ts: `100${++ts}.000` }))
  const update = vi.fn(async (_req: any) => ({ ok: true }))
  const filesUploadV2 = vi.fn(async () => ({ ok: true, files: [] }))
  ;(connector as any).app = { client: { chat: { postMessage, update }, filesUploadV2, assistant: { threads: { setStatus: vi.fn(async () => ({ ok: true })) } } } }
  return { connector, postMessage, update }
}

const start = (c: SlackConnector, id: string) => c.showToolStart('D1', { toolUseId: id, toolName: 'Bash', summary: `cmd ${id}` })
const settle = (c: SlackConnector, id: string, outcome: ToolOutcome) => c.showToolOutcome('D1', id, outcome)

const cardsIn = (call: any) => call[0].blocks.map((b: any) => `${b.task_id}:${b.status}`)

describe('SlackConnector tool groups', () => {
  it('puts consecutive tools in one group message and updates their cards in place', async () => {
    const { connector, postMessage, update } = makeConnector()

    await start(connector, 't1')
    await start(connector, 't2')
    await settle(connector, 't1', 'success')
    await settle(connector, 't2', 'error')

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(update.mock.calls.map(cardsIn)).toEqual([
      ['t1:in_progress', 't2:in_progress'],
      ['t1:complete', 't2:in_progress'],
      ['t1:complete', 't2:error'],
    ])
    expect(update.mock.calls.at(-1)![0].text).toBe('Bash: cmd t1 (done)\nBash: cmd t2 (failed)')
  })

  it('starts a new group after any other bot post, and still updates the closed group', async () => {
    const { connector, postMessage, update } = makeConnector()

    await start(connector, 't1')
    await connector.sendMessage('D1', { text: 'answer text' })
    await start(connector, 't2')
    await settle(connector, 't1', 'success')

    const groupPosts = postMessage.mock.calls.filter((c: any) => c[0].blocks)
    expect(groupPosts.map(cardsIn)).toEqual([['t1:in_progress'], ['t2:in_progress']])
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ ts: '1001.000' }))

    update.mockClear()
    await settle(connector, 'orphan', 'success')
    expect(update).not.toHaveBeenCalled()
  })

  it.each([
    ['a message', (c: SlackConnector) => c.sendMessage('D1', { text: 'answer' })],
    ['a file', (c: SlackConnector) => c.sendFile('D1', Buffer.from('x'), 'x.txt')],
    ['the first streamed answer post', (c: SlackConnector) => c.sendStreamingUpdate('D1', 'partial answer')],
    ['a request card', (c: SlackConnector) => c.sendUserRequestCard('D1', { type: 'secret_request', toolUseId: 'q1', secretName: 'KEY' })],
  ])('closes the open group after %s, so the next tool starts a new group', async (_name, post) => {
    const { connector, postMessage } = makeConnector()

    await start(connector, 't1')
    await post(connector)
    await start(connector, 't2')

    expect(postMessage.mock.calls.filter((c: any) => c[0].blocks).map(cardsIn)).toEqual([['t1:in_progress'], ['t2:in_progress']])
  })

  it.each([
    { format: 'standard markdown', chunkSize: 12000, converted: false },
    { format: 'converted text', chunkSize: 2500, converted: true },
  ])('closes the group after each $format chunk, before the last chunk lands', async ({ chunkSize, converted }) => {
    const { connector, postMessage } = makeConnector()
    await start(connector, 't1')
    if (converted) {
      postMessage.mockRejectedValueOnce(Object.assign(new Error('invalid_blocks'), {
        code: 'slack_webapi_platform_error', data: { ok: false, error: 'invalid_blocks' },
      }))
    }
    postMessage.mockResolvedValueOnce({ ok: true, ts: '2000.001' })
    postMessage.mockImplementationOnce(async () => {
      await start(connector, 't2')
      return { ok: true, ts: '2000.002' }
    })

    await connector.sendMessage('D1', { text: 'a'.repeat(chunkSize) + '\n\n' + 'b'.repeat(chunkSize) })

    expect(postMessage.mock.calls.filter((c: any) => c[0].blocks?.[0]?.type === 'task_card').map(cardsIn)).toEqual([['t1:in_progress'], ['t2:in_progress']])
  })

  it('starts a new group past the card limit, and routes the last tool\'s outcome to it', async () => {
    const { connector, postMessage, update } = makeConnector()

    for (let i = 0; i <= MAX_TOOL_GROUP_CARDS; i++) await start(connector, `t${i}`)
    await settle(connector, `t${MAX_TOOL_GROUP_CARDS}`, 'success')

    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ ts: '1002.000' }))
  })

  it('leaves out a tool whose join edit failed, so later redraws never show it running', async () => {
    const { connector, update } = makeConnector()
    await start(connector, 't1')
    update.mockRejectedValueOnce(new Error('ratelimited'))

    await expect(start(connector, 't2')).rejects.toThrow('ratelimited')
    await settle(connector, 't1', 'success')

    expect(cardsIn(update.mock.calls.at(-1))).toEqual(['t1:complete'])
  })

  it.each([
    ['a user message', (c: SlackConnector) => (c as any).closeToolGroup('D1')],
    ['a request card', (c: SlackConnector) => c.sendUserRequestCard('D1', { type: 'secret_request', toolUseId: 'q1', secretName: 'KEY' })],
  ])('keeps a group closed when %s lands while it is being posted', async (_name, closer) => {
    const { connector, postMessage } = makeConnector()
    postMessage.mockImplementationOnce(async () => {
      await closer(connector)
      return { ok: true, ts: '1001.000' }
    })

    await start(connector, 't1')
    await start(connector, 't2')

    expect(postMessage.mock.calls.filter((c: any) => c[0].blocks?.[0]?.type === 'task_card').map(cardsIn)).toEqual([['t1:in_progress'], ['t2:in_progress']])
  })

  it('closes the group after each question post, so a tool arriving before the last one starts a new group', async () => {
    const { connector, postMessage } = makeConnector()
    let releaseGroupPost!: () => void
    postMessage.mockImplementationOnce(() => new Promise((resolve) => { releaseGroupPost = () => resolve({ ok: true, ts: '1001.000' }) }))
    const groupPost = start(connector, 't1')
    postMessage.mockImplementationOnce(async () => ({ ok: true, ts: '1002.000' }))
    postMessage.mockImplementationOnce(async () => {
      releaseGroupPost()
      await groupPost
      await start(connector, 't2')
      return { ok: true, ts: '1004.000' }
    })

    await connector.sendUserRequestCard('D1', { type: 'question_request', toolUseId: 'q1', questions: [{ question: 'One?' }, { question: 'Two?' }] })

    expect(postMessage.mock.calls.filter((c: any) => c[0].blocks?.[0]?.type === 'task_card').map(cardsIn)).toEqual([['t1:in_progress'], ['t2:in_progress']])
  })

  it('escapes Slack control characters in the fallback text', () => {
    expect(toolGroupText([{ id: 't1', title: 'Bash: echo <!channel> & done', status: 'success' }])).toBe('Bash: echo &lt;!channel&gt; &amp; done (done)')
  })

  it('draws a stopped tool as an error with a note', () => {
    const [block] = toolGroupBlocks([{ id: 't1', title: 'Bash', status: 'cancelled' }])
    expect(block).toMatchObject({ type: 'task_card', task_id: 't1', status: 'error', output: { type: 'rich_text' } })
  })
})
