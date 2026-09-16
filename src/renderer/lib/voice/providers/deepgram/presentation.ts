import type { VoiceProviderOption, VoiceProviderKeyConfig } from '../../contracts/presentation'

export const deepgramOption: VoiceProviderOption = {
  value: 'deepgram', label: 'Deepgram', model: 'Nova 3',
  docsUrl: 'https://developers.deepgram.com/docs/models-languages-overview',
  note: 'Lowest latency (~200ms). 47 languages supported.',
}
export const platformOption: VoiceProviderOption = {
  value: 'platform', label: 'Platform', model: 'Nova 3',
  note: 'Uses Deepgram via your platform connection. No API key required.', platformOnly: true,
}
export const deepgramKeyConfig: VoiceProviderKeyConfig = {
  envVar: 'DEEPGRAM_API_KEY', placeholder: 'Enter your Deepgram API key',
  apiKeyField: 'deepgramApiKey', statusField: 'deepgram',
  dashboardUrl: 'https://console.deepgram.com/', dashboardLabel: 'Deepgram Console',
}
