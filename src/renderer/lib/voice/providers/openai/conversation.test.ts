import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(), release: vi.fn(), suspend: vi.fn(), context: vi.fn(), callbacks: {} as { onClosed(): void } }))
vi.mock('../../services/read-aloud', () => ({ readAloud: { suspend: mocks.suspend } }))
vi.mock('./live-session', () => ({ OpenAILiveConversation: class {
  constructor(events: typeof mocks.callbacks, history: unknown, agentSlug: string) { mocks.callbacks = events; mocks.context(history, agentSlug) }
  start = mocks.start
  close = mocks.close
  setPaused = vi.fn()
} }))
import { OpenAILiveConversationAdapter } from './conversation'
function setup() {
  return new OpenAILiveConversationAdapter({ sessionId: 'session', agentSlug: 'agent', history: [] }, {
    onCommand: vi.fn(), onSnapshot: vi.fn(), onError: vi.fn(),
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.suspend.mockReturnValue(mocks.release)
  mocks.start.mockResolvedValue(undefined)
})
describe('Live audio ownership', () => {
  it('passes the selected agent to Live startup', () => {
    setup()
    expect(mocks.context).toHaveBeenCalledExactlyOnceWith([], 'agent')
  })
  it('reserves audio before connecting, retains it while paused, and releases on close', async () => {
    const adapter = setup()
    mocks.start.mockImplementation(async () => expect(mocks.suspend).toHaveBeenCalledOnce())
    await adapter.start()
    adapter.setPaused(true)
    expect(mocks.release).not.toHaveBeenCalled()
    adapter.close()
    adapter.close()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('releases read-aloud when starting fails', async () => {
    const adapter = setup()
    mocks.start.mockRejectedValue(new Error('Permission denied'))
    await expect(adapter.start()).rejects.toThrow('Permission denied')
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('releases read-aloud when the remote call closes', async () => {
    const adapter = setup()
    await adapter.start()
    mocks.callbacks.onClosed()
    expect(mocks.release).toHaveBeenCalledOnce()
    adapter.close()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
