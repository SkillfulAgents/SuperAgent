import type { LlmProxyAdapter } from './llm-proxy'
import { grokProxyAdapter } from './llm-proxy-grok'
import type { LlmProxyConfig } from './llm-proxy-schema'

const adapters: Partial<Record<NonNullable<LlmProxyConfig['adapter']>, LlmProxyAdapter>> = {
  grok: grokProxyAdapter,
}

export function adapterForProxy(config: LlmProxyConfig): LlmProxyAdapter | undefined {
  return config.adapter ? adapters[config.adapter] : undefined
}
