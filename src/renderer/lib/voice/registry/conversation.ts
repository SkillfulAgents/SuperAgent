import type { VoiceConversationAdapter, VoiceConversationContext, VoiceConversationEngine, VoiceConversationEvents } from '../contracts/conversation'
import { ChainedConversationAdapter } from '../engines/chained-conversation'
import { OpenAILiveConversationAdapter } from '../providers/openai/conversation'

export function createVoiceConversation(engine: VoiceConversationEngine, context: VoiceConversationContext, events: VoiceConversationEvents): VoiceConversationAdapter {
  switch (engine) {
    case 'chained': return new ChainedConversationAdapter(context, events)
    case 'openai-live': return new OpenAILiveConversationAdapter(context, events)
  }
}
