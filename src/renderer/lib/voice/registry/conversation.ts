import type { VoiceConversationAdapter, VoiceConversationContext, VoiceConversationEngine, VoiceConversationEvents } from '../contracts/conversation'
import { ChainedConversationAdapter } from '../conversation/chained'
import { OpenAILiveConversationAdapter } from '../providers/openai/conversation'

type Factory = (context: VoiceConversationContext, events: VoiceConversationEvents) => VoiceConversationAdapter

// Exhaustive by type: every engine the host can report has an adapter here.
const engines = {
  chained: (context, events) => new ChainedConversationAdapter(context, events),
  'openai-live': (context, events) => new OpenAILiveConversationAdapter(context, events),
} satisfies Record<VoiceConversationEngine, Factory>

export function createVoiceConversation(engine: VoiceConversationEngine, context: VoiceConversationContext, events: VoiceConversationEvents): VoiceConversationAdapter {
  return engines[engine](context, events)
}
