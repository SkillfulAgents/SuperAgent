import type { VoiceProviderOption, VoiceProviderKeyConfig } from '../../contracts/presentation'

export const openaiOption: VoiceProviderOption = {
  value: 'openai', label: 'OpenAI', model: 'GPT-4o Mini Transcribe · GPT-Live',
  docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text#supported-languages',
  note: 'Dictation and read-aloud use your OpenAI API key. Conversation voice uses GPT-Live and the app’s configured summarizer.',
}
export const openaiKeyConfig: VoiceProviderKeyConfig = {
  envVar: 'OPENAI_API_KEY', placeholder: 'sk-...',
  apiKeyField: 'openaiApiKey', statusField: 'openai',
  dashboardUrl: 'https://platform.openai.com/api-keys', dashboardLabel: 'OpenAI Dashboard',
}
export const openaiConversationNotice = 'Conversation voice uses OpenAI Live with the Marin voice. The voice and speed settings above apply to read-aloud playback. Open an agent conversation and press the voice button to talk.'
