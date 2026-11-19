import { describe, expect, it } from 'vitest'
import { DEFAULT_OLLAMA_BASE_URL, normalizeOllamaBaseUrl, ollamaModelNameSchema } from './ollama-schema'

describe('normalizeOllamaBaseUrl', () => {
  it.each([
    [undefined, DEFAULT_OLLAMA_BASE_URL],
    ['  ', DEFAULT_OLLAMA_BASE_URL],
    ['localhost', 'http://localhost:11434'],
    ['localhost:12345', 'http://localhost:12345'],
    ['http://localhost:11434/', 'http://localhost:11434'],
    ['http://localhost:11434/v1', 'http://localhost:11434'],
    ['http://localhost:11434/api/', 'http://localhost:11434'],
    ['192.168.1.20', 'http://192.168.1.20:11434'],
    // An explicit scheme means the port was chosen too, e.g. a reverse proxy.
    ['https://ollama.example.com', 'https://ollama.example.com'],
    ['https://proxy.example.com/ollama/', 'https://proxy.example.com/ollama'],
    ['http://[::1]:11434', 'http://[::1]:11434'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeOllamaBaseUrl(input)).toBe(expected)
  })

  it('refuses what containers could not use, and says why', () => {
    expect(() => normalizeOllamaBaseUrl('ftp://example.com')).toThrow('http://')
    expect(() => normalizeOllamaBaseUrl('http://example.com?x=1')).toThrow('query string')
    expect(() => normalizeOllamaBaseUrl('http://me:secret@example.com')).toThrow('credentials')
    expect(() => normalizeOllamaBaseUrl('http://my-mac:11434')).toThrow('my-mac')
    expect(() => normalizeOllamaBaseUrl('http://a b')).toThrow('Enter a URL')
  })
})

describe('ollamaModelNameSchema', () => {
  it.each(['qwen3.8', 'qwen3.8:27b', ' qwen3.8:latest ', 'someone/model:tag', 'hf.co/org/repo:Q4_K_M', 'gemma4:e4b-it-qat'])('accepts %j', (name) => {
    expect(ollamaModelNameSchema.safeParse(name).success).toBe(true)
  })

  it.each(['', ' ', '-flag', 'a b', 'a;b', '../x', 'a//b', 'a:', 'a:b:c', 'https://ollama.com/library/qwen3.8'])('rejects %j', (name) => {
    expect(ollamaModelNameSchema.safeParse(name).success).toBe(false)
  })

  it.each(['glm-5.3:cloud', 'gpt-oss:120b-cloud'])('says a cloud model cannot be downloaded: %s', (name) => {
    expect(ollamaModelNameSchema.safeParse(name).error?.issues[0].message).toContain('Cloud models')
  })
})
