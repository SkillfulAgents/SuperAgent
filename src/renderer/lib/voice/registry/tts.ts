import type { TtsSession } from '@shared/lib/voice/tts-types'
import type { TtsAdapter } from '../contracts/tts'
import { DeepgramTtsAdapter } from '../providers/deepgram/tts'
import { HttpTtsAdapter } from '../shared/http-tts'

export function createTtsAdapter({ provider, connection }: Pick<TtsSession, 'provider' | 'connection'>): TtsAdapter {
  switch (connection.transport) {
    case 'websocket': return new DeepgramTtsAdapter(connection.token)
    case 'http': return new HttpTtsAdapter(provider)
  }
}
