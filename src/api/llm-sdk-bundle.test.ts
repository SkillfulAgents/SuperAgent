import { describe, expect, it } from 'vitest'
import { ANTHROPIC_SDK_BUNDLE } from './llm-sdk-bundle'

describe('dashboard Anthropic SDK bundle', () => {
  it('is executable browser JavaScript that installs the SDK constructor', () => {
    const dashboardWindow: Record<string, unknown> = {}
    const evaluate = new Function('window', ANTHROPIC_SDK_BUNDLE)

    evaluate(dashboardWindow)

    expect(dashboardWindow.__AnthropicSDK).toBeTypeOf('function')
  })

  it('contains the browser bridge expected by the lazy dashboard polyfill', () => {
    expect(ANTHROPIC_SDK_BUNDLE).toContain('window.__AnthropicSDK =')
  })
})
