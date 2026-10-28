/**
 * Creating a session and sending it a message, under the NFS shim.
 *
 * The send path's cost is mostly serial file operations on the agent's
 * session-metadata document: every one is a network round trip on EFS-class
 * storage, and a message reaches the agent only after those ahead of the
 * container POST are done. Each send scenario pins two things:
 *
 *   - "delivered": the operations (and wall-clock) up to the moment the
 *     container receives the message, i.e. the delay before the agent starts
 *     its turn. Taken from inside the mock container's turn, which starts once
 *     the client has done everything it does before its HTTP POST.
 *   - the whole request, up to the response the client waits on.
 *
 * The app has a default LLM connection, so a send resolves and binds the
 * session's provider exactly as an installed app does. The mock container's
 * turns are silent and are ended by hand between measurements, so nothing the
 * agent does lands inside one. Every count includes the mock container's own
 * E2E recorder (`sync.existsSync`, `sync.appendFileSync` and the
 * `sync.writeFileSync` it makes): three operations a real container does not
 * cost the host.
 *
 * Recorded before SUP-1183 at 10 ms/op: an unchanged send took 20 operations
 * (184 ms) to reach the container and 29 (281 ms) to answer; a model switch
 * 19 (171 ms) and 28 (267 ms); a create 25.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootPerfApp, expectWithinBudget, measure, type Measurement, type PerfApp } from './harness'
import { nfsShimSnapshot } from './nfs-shim'

const SILENT = 'perf-silent-turn'

interface Turn {
  end(): void
}

describe('session create + send — small profile', () => {
  let perf: PerfApp
  let slug: string
  let sessionId: string
  let measureStartedAt = 0
  let delivered: Measurement | null = null
  const turns = new Map<string, Turn>()

  /** Ends the session's running turn, then waits for the host to settle it. */
  const endTurn = async () => {
    const turn = turns.get(sessionId)
    expect(turn).toBeDefined()
    turn!.end()
    turns.delete(sessionId)
    const { agentRegistry } = await import('@shared/lib/agent-actor')
    await expect.poll(async () => (await agentRegistry.get(slug).sessions.live(sessionId)).isActive).toBe(false)
    // Whatever settling writes (activity, usage) lands before the next measurement.
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  const post = async (url: string, body: unknown) =>
    perf.app.request(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    perf = await bootPerfApp('small')
    slug = perf.seeded.agentSlugs[0]

    const { saveConnection, setGlobalSelection } = await import('@shared/lib/llm-provider/connections')
    const catalog = ['model-a', 'model-b'].map((id) => ({ id, label: id, supportedEfforts: ['low', 'high'] }))
    const llmProviderId = await saveConnection(
      { name: 'perf', provider: 'generic', config: { apiKeys: { genericApiKey: 'perf-key', genericBaseUrl: 'https://perf.example' } }, modelOverrides: catalog },
      { userId: null, admin: true },
    )
    await setGlobalSelection('default', { llmProviderId, model: 'model-a' })

    const { MockContainerClient } = await import('@shared/lib/container/mock-container-client')
    MockContainerClient.registerScenario(SILENT, {
      execute(id, client, userMessage) {
        // The container has the message: everything the host did before
        // handing it over is behind us.
        if (measureStartedAt) {
          delivered = { wallMs: performance.now() - measureStartedAt, ...nfsShimSnapshot() }
        }
        turns.set(id, {
          end() {
            client.writeJsonlEntry(id, { type: 'user', message: { content: userMessage }, timestamp: new Date().toISOString() })
            client.writeJsonlEntry(id, {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'ok' }] },
              timestamp: new Date().toISOString(),
            })
            client.emitStreamMessage(id, { type: 'result', content: { type: 'result', subtype: 'success' } })
          },
        })
      },
    })

    const { agentRegistry } = await import('@shared/lib/agent-actor')
    await agentRegistry.get(slug).container.start()
  })

  afterAll(async () => {
    const { MockContainerClient } = await import('@shared/lib/container/mock-container-client')
    MockContainerClient.scenarios.delete(SILENT)
    await perf?.dispose()
  })

  const measureRequest = async (fn: () => Promise<Response>) => {
    delivered = null
    measureStartedAt = performance.now()
    try {
      return await measure(fn, { settle: true })
    } finally {
      measureStartedAt = 0
    }
  }

  it('creates a session', async () => {
    const { result, measurement } = await measureRequest(() =>
      post(`/api/agents/${slug}/sessions`, { message: `${SILENT}: start` }),
    )
    expect(result.status).toBe(201)
    sessionId = ((await result.json()) as { id: string }).id

    // The mock delivers a new session's first message on a timer of its own.
    await expect.poll(() => turns.has(sessionId)).toBe(true)
    await endTurn()

    // Secrets and preferences for the container, the registration (with the
    // container's slash commands in it), and the name the first message gives
    // the session, written once the response is out. The stream's lifecycle
    // comes from the registration, not a read of it.
    expectWithinBudget('small: create session', measurement, {
      totalOps: 22,
      ops: { readFile: 4, rename: 2 },
      wallMs: 260,
    })
  })

  it('sends a message that changes nothing about the session', async () => {
    const { result, measurement } = await measureRequest(() =>
      post(`/api/agents/${slug}/sessions/${sessionId}/messages`, { content: `${SILENT}: follow-up` }),
    )
    expect(result.status).toBe(201)
    expect(delivered).not.toBeNull()
    // One realpath for "is this the agent's session" (and one more for the
    // workspace root, the first time this actor resolves a path), one read of
    // the session's metadata, and no write: the send changes nothing.
    const unchanged = { totalOps: 6, ops: { readFile: 1, rename: 0, 'handle.sync': 0 }, wallMs: 80 }
    expectWithinBudget('small: send, unchanged session (delivered)', delivered!, unchanged)
    expectWithinBudget('small: send, unchanged session (response)', measurement, unchanged)
    await endTurn()
  })

  it('sends a message that switches the model and effort', async () => {
    const { result, measurement } = await measureRequest(() =>
      post(`/api/agents/${slug}/sessions/${sessionId}/messages`, { content: `${SILENT}: switch`, model: 'model-b', effort: 'high' }),
    )
    expect(result.status).toBe(201)
    expect(delivered).not.toBeNull()

    const { agentRegistry } = await import('@shared/lib/agent-actor')
    expect(await agentRegistry.get(slug).sessions.metadata(sessionId)).toMatchObject({ model: 'model-b', effort: 'high' })

    // The read, then one atomic write (its locked re-read, temp file, fsync,
    // rename, directory fsync) holding the new binding AND the effort. It has
    // to land before the container has the message (the container's
    // credential callback checks the stored binding), so nothing is left to
    // write after the POST.
    const switched = { totalOps: 13, ops: { readFile: 2, rename: 1, 'handle.sync': 2 }, wallMs: 230 }
    expectWithinBudget('small: send, model switch (delivered)', delivered!, switched)
    expectWithinBudget('small: send, model switch (response)', measurement, switched)
    await endTurn()
  })
})
