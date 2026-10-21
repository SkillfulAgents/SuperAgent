/**
 * Test helper: a stand-in `LiveSessions` class, for a test that drives routes
 * or services through the real registry but decides itself what the agents'
 * live sessions answer.
 *
 *   const mockIsActive = vi.fn(() => false)
 *   vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
 *     LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble({
 *       isActive: (slug, sessionId) => mockIsActive(slug, sessionId),
 *     }),
 *   }))
 *
 * Each answer takes the agent's slug, then the method's own arguments. A
 * method with no answer behaves as an agent with nothing live: reads are
 * empty or false, marks do nothing, a delivery runs at once and is never queued.
 */
import type { LiveSessions, LiveSessionsDeps } from '../live/live-sessions'

type Methods = {
  [K in keyof LiveSessions as LiveSessions[K] extends (...args: never[]) => unknown ? K : never]: LiveSessions[K]
}

export type LiveSessionsAnswers = {
  [K in keyof Methods]?: (slug: string, ...args: Parameters<Methods[K]>) => ReturnType<Methods[K]>
}

const NOTHING_LIVE: { [K in keyof Methods]: (...args: Parameters<Methods[K]>) => ReturnType<Methods[K]> } = {
  activity: () => 'idle',
  isActive: () => false,
  isAwaitingInput: () => false,
  isWaitingBackground: () => false,
  hasOnlyUntrackedBackgroundWork: () => false,
  turnGeneration: () => 0,
  turnOutcome: () => null,
  backgroundTasks: () => [],
  activeSubagents: () => [],
  slashCommands: () => [],
  setSlashCommands: () => {},
  settledRequests: () => new Map(),
  reconcileTranscript: () => ({ settled: {} }),
  awaitingIds: () => [],
  runtime: () => undefined,
  recordRuntime: () => {},
  isRecovering: () => false,
  isSubscribed: () => false,
  activeIds: () => [],
  hasActive: () => false,
  hasAwaitingInput: () => false,
  pendingComputerUse: () => [],
  capabilityGranted: () => false,
  listen: () => () => {},
  onDispose: () => () => {},
  follow: async () => () => {},
  emit: () => {},
  subscribe: async () => {},
  attachReplaying: async () => {},
  unsubscribe: () => {},
  detach: () => {},
  markActive: () => {},
  markIdle: () => {},
  markInterrupted: () => {},
  markAllInactive: () => {},
  claimMidTurnForRecovery: () => [],
  markRecovered: () => {},
  settleRecovering: () => {},
  coalesceIfRecovering: () => false,
  takeCoalesced: () => [],
  dropCoalesced: () => false,
  inDeliveryTurn: (_sessionId, work) => work(),
  markSending: () => ({ queued: false, rollback: () => {} }),
  waitForIdle: async () => 'idle',
  syncAwaiting: () => {},
  recoverAwaitingInput: () => {},
  grantCapability: () => {},
  completeRequest: () => {},
  completeCapabilityReview: () => {},
  clearComputerUseRequest: () => {},
  cancelAwaitingInput: async () => {},
  promoteAutomated: async (_sessionId, metadata) => metadata ?? null,
  requestTransition: () => {},
  dispose: () => {},
}

export function liveSessionsDouble(answers: LiveSessionsAnswers = {}): typeof LiveSessions {
  class LiveSessionsDouble {
    constructor(deps: LiveSessionsDeps) {
      for (const name of Object.keys(NOTHING_LIVE) as Array<keyof Methods>) {
        const answer = answers[name] as ((slug: string, ...args: unknown[]) => unknown) | undefined
        const fallback = NOTHING_LIVE[name] as (...args: unknown[]) => unknown
        Object.defineProperty(this, name, {
          value: answer ? (...args: unknown[]) => answer(deps.slug, ...args) : fallback,
        })
      }
    }
  }
  return LiveSessionsDouble as unknown as typeof LiveSessions
}
