import { getVoiceProvider } from '.'
import { LiveSessionRegistry } from './live-session-registry'
import type { VoiceProvider } from './provider-types'

// A session is hung up through the provider that created it, with that
// provider's key as configured now: AppState keeps no keys. A key replaced
// while the session runs can make the hangup fail.
async function hangUpLiveSession(providerId: VoiceProvider, providerSessionId: string): Promise<void> {
  const provider = getVoiceProvider(providerId)
  const conversation = provider.getLiveConversation()
  if (!conversation) throw new Error(`${provider.name} cannot close Live sessions.`)
  await conversation.closeLiveSession(providerSessionId, await provider.getEffectiveApiKey())
}

const globalForLiveSessions = globalThis as unknown as { liveSessions?: LiveSessionRegistry }

// Admission and handles live in AppState, so a release can reach any process;
// each process keeps its own hangup retries and deadline hangups. So it keeps one
// registry, across Vite re-instantiating this module: a wakeup finds its session
// only in the registry that set it.
export const liveSessions = globalForLiveSessions.liveSessions ?? new LiveSessionRegistry(hangUpLiveSession)

if (process.env.NODE_ENV !== 'production') {
  globalForLiveSessions.liveSessions = liveSessions
}
