import type { VoiceProvider } from '@shared/lib/config/settings'

export type ApiKeyProvider = Exclude<VoiceProvider, 'platform'>

export interface VoiceProviderOption {
  value: VoiceProvider
  label: string
  model: string
  docsUrl?: string
  note: string
  platformOnly?: boolean
}

export interface VoiceProviderKeyConfig {
  envVar: string
  placeholder: string
  apiKeyField: `${ApiKeyProvider}ApiKey`
  statusField: ApiKeyProvider
  dashboardUrl: string
  dashboardLabel: string
}
