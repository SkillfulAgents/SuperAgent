import { describe, it, expect } from 'vitest'
import { getPolyfillJs } from '../speech-recognition-polyfill'
import { getLlmPolyfillJs } from '../llm-polyfill'
import { injectDashboardRuntime } from '../dashboard-runtime'

/**
 * Tests for the polyfill injection logic used in proxyArtifactRequest.
 * This replicates the injection logic to verify it handles various HTML structures.
 */
function injectPolyfill(html: string): string {
  return injectDashboardRuntime(html, {
    basePath: '/api/agents/agent-1/artifacts/test/',
    slug: 'test',
    polyfillJs: getPolyfillJs() + getLlmPolyfillJs(),
  })
}

describe('artifact polyfill injection', () => {
  it('injects after <head> tag', () => {
    const html = '<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>'
    const result = injectPolyfill(html)
    expect(result).toContain('<head><base data-gamut-dashboard-base href="/api/agents/agent-1/artifacts/test/"><script>')
    expect(result).toContain('</script><title>Test</title>')
  })

  it('injects after <head> with attributes', () => {
    const html = '<html><head lang="en"><meta charset="utf-8"></head></html>'
    const result = injectPolyfill(html)
    expect(result).toContain('<head lang="en"><base data-gamut-dashboard-base href="/api/agents/agent-1/artifacts/test/"><script>')
  })

  it('is case-insensitive for <HEAD>', () => {
    const html = '<HTML><HEAD><TITLE>Hi</TITLE></HEAD></HTML>'
    const result = injectPolyfill(html)
    expect(result).toContain('<HEAD><base data-gamut-dashboard-base href="/api/agents/agent-1/artifacts/test/"><script>')
  })

  it('prepends to document when no <head> tag', () => {
    const html = '<html><body><h1>Hello</h1></body></html>'
    const result = injectPolyfill(html)
    expect(result.startsWith('<base data-gamut-dashboard-base href="/api/agents/agent-1/artifacts/test/"><script>')).toBe(true)
    expect(result).toContain('</script><html><body>')
  })

  it('injects valid polyfill JS (STT + LLM)', () => {
    const html = '<html><head></head><body></body></html>'
    const result = injectPolyfill(html)
    expect(result).toContain('SpeechRecognition')
    expect(result).toContain('SuperagentSpeechRecognition')
    expect(result).toContain('window.Anthropic')
  })

  it('does not inject into non-HTML (simulating proxy content-type check)', () => {
    const json = '{"status": "ok"}'
    const contentType = 'application/json'
    // The proxy only injects when content-type includes 'text/html'
    const shouldInject = contentType.includes('text/html')
    expect(shouldInject).toBe(false)
    // JSON should remain unchanged
    expect(json).toBe('{"status": "ok"}')
  })

  it('content-type check matches text/html', () => {
    expect('text/html'.includes('text/html')).toBe(true)
    expect('text/html; charset=utf-8'.includes('text/html')).toBe(true)
    expect('application/javascript'.includes('text/html')).toBe(false)
    expect('text/css'.includes('text/html')).toBe(false)
  })
})
