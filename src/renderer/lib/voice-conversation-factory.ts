import { DeepgramConversationAdapter } from './voice-conversation-deepgram'
import { OpenAILiveConversationAdapter } from './voice-conversation-live'
import type { VoiceConversationAdapter, VoiceConversationContext, VoiceConversationEngine, VoiceConversationEvents } from './voice-conversation'

export function createVoiceConversation(engine: VoiceConversationEngine, context: VoiceConversationContext, events: VoiceConversationEvents): VoiceConversationAdapter {
  switch (engine) {
    case 'chained': return new DeepgramConversationAdapter(context, events)
    case 'openai-live': return new OpenAILiveConversationAdapter(context, events)
  }
}
