import { describe, it, expect, vi } from 'vitest'
import { SlackConnector } from './slack-connector'

// The thinking-reaction surface is a live Slack reaction that never expires, so a
// teardown that loses track of a reaction strands "Working…" forever. These tests drive
// the real startWorking/stopWorking against a mock Slack web client.

function makeConnector() {
  const add = vi.fn(async () => ({ ok: true }))
  const remove = vi.fn(async () => ({ ok: true }))
  const connector = new SlackConnector({ botToken: 'xoxb-test', appToken: 'xapp-test' })
  // app is private and only built on connect(); inject a mock exposing what reactions use.
  ;(connector as unknown as { app: unknown }).app = { client: { reactions: { add, remove } } }
  return { connector, add, remove }
}

function seedUserMessage(connector: SlackConnector, chatId: string, ts: string) {
  ;(connector as unknown as { lastUserMessageTs: Map<string, string> }).lastUserMessageTs.set(chatId, ts)
}

describe('SlackConnector thinking-reaction teardown', () => {
  it('keeps the reaction tracked when reactions.remove fails transiently, so a later clear retries', async () => {
    const { connector, remove } = makeConnector()
    remove
      .mockRejectedValueOnce({ data: { error: 'ratelimited' } }) // first clear: transient failure
      .mockResolvedValueOnce({ ok: true }) // second clear: succeeds
    seedUserMessage(connector, 'C1', '100.1')

    await connector.startWorking('C1', 'working') // add + track
    await connector.stopWorking('C1') // remove fails transiently → key must stay tracked
    await connector.stopWorking('C1') // retry → remove attempted again

    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('drops tracking when the reaction is already gone (no endless retry)', async () => {
    const { connector, remove } = makeConnector()
    remove.mockRejectedValue({ data: { error: 'no_reaction' } })
    seedUserMessage(connector, 'C1', '100.1')

    await connector.startWorking('C1', 'working')
    await connector.stopWorking('C1') // "no_reaction" means gone → untrack
    await connector.stopWorking('C1') // nothing tracked → no further remove attempt

    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('tracks the reaction even when reactions.add throws, so teardown can still remove it', async () => {
    const { connector, add, remove } = makeConnector()
    // The add lands on Slack but the client sees an error (lost response after commit).
    add.mockRejectedValueOnce({ data: { error: 'ratelimited' } })
    seedUserMessage(connector, 'C1', '100.1')

    await connector.startWorking('C1', 'working') // add "fails" client-side but may be live
    await connector.stopWorking('C1') // must still attempt to remove it

    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100.1', name: 'thinking_face' }),
    )
  })

  it('a sweep over two tracked reactions drops only the confirmed-gone one and retries the other', async () => {
    const { connector, remove } = makeConnector()
    // A second message landed mid-turn, so TWO reactions are tracked. The sweep
    // visits them in insertion order: the first removes cleanly, the second
    // fails transiently and must stay tracked.
    remove
      .mockResolvedValueOnce({ ok: true }) // '100.1' → settled, untracked
      .mockRejectedValueOnce({ data: { error: 'ratelimited' } }) // '200.2' → kept
    seedUserMessage(connector, 'C1', '100.1')
    await connector.startWorking('C1', 'working')
    seedUserMessage(connector, 'C1', '200.2')
    await connector.startWorking('C1', 'working')

    await connector.stopWorking('C1') // sweep attempts both
    expect(remove).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ timestamp: '100.1' }))
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ timestamp: '200.2' }))

    remove.mockClear()
    await connector.stopWorking('C1') // retry sweep: only the kept key
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ timestamp: '200.2' }))
  })

  it('serializes a paint then clear so the reaction ends up removed even if add resolves late', async () => {
    const { connector, add, remove } = makeConnector()
    let releaseAdd!: () => void
    const addGate = new Promise<void>((r) => { releaseAdd = r })
    add.mockImplementationOnce(async () => { await addGate; return { ok: true } }) // slow add
    seedUserMessage(connector, 'C1', '100.1')

    const painting = connector.startWorking('C1', 'working') // enqueues a slow add
    const clearing = connector.stopWorking('C1') // enqueues the remove behind it
    releaseAdd()
    await Promise.all([painting, clearing])

    // The remove must run AFTER the add completes, so the final state is "removed".
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    const addOrder = add.mock.invocationCallOrder[0]
    const removeOrder = remove.mock.invocationCallOrder[0]
    expect(removeOrder).toBeGreaterThan(addOrder)
  })
})
