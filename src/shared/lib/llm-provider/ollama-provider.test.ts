import { describe, expect, it } from 'vitest'
import { OllamaLlmProvider } from './ollama-provider'

const bound = (ollamaBaseUrl?: string) => new OllamaLlmProvider({ apiKeys: { ollamaBaseUrl }, env: {} })

describe('OllamaLlmProvider', () => {
  it('reads as configured only when bound to a connection, so onboarding is not fooled', () => {
    expect(new OllamaLlmProvider().apiKeyStatusFrom({ apiKeys: {} } as never).isConfigured).toBe(false)
    expect(bound().apiKeyStatusFrom(undefined).isConfigured).toBe(true)
  })

  it('points a container at the host, with the token the CLI insists on', async () => {
    expect(await bound().getContainerEnvVars()).toEqual({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
    })
  })

  it('leaves an address on another machine alone', async () => {
    const env = await bound('http://192.168.1.20:9999').getContainerEnvVars()
    expect(env.ANTHROPIC_BASE_URL).toBe('http://192.168.1.20:9999')
  })

  it('does not offer deferred tools, which Ollama does not expand', async () => {
    expect(await bound().toolSearchEnv('qwen3.8:latest')).toBe('false')
  })

  it('saves a normalized address, and refuses one it cannot use', () => {
    const config = { apiKeys: { ollamaBaseUrl: 'localhost:9000/' }, runtimeEnv: {}, env: {} }
    expect(bound().normalizeConnectionConfig(config).apiKeys.ollamaBaseUrl).toBe('http://localhost:9000')
    expect(() => bound().normalizeConnectionConfig({ ...config, apiKeys: { ollamaBaseUrl: 'http://my-mac:11434' } })).toThrow(/my-mac/)
  })

  it('has no built-in models', () => {
    expect(bound().getBuiltinCatalog()).toEqual([])
  })
})
