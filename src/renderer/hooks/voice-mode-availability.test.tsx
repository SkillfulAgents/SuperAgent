// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: state.data }) }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track: vi.fn() }) }))
import { useCanUseVoiceMode, useIsTtsConfigured, useVoiceConversationEngine } from './use-voice-input'

describe('conversation capability is independent of standalone read-aloud', () => {
  it.each([
    ['openai-live', true, false, true],
    ['chained', true, true, true],
    [null, false, false, false],
  ])('%s configured=%s tts=%s available=%s', (engine, configured, supportsTts, available) => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } })
    state.data = { configured, supportsTts, conversationEngine: engine }
    const { result, unmount } = renderHook(() => ({ available: useCanUseVoiceMode(), tts: useIsTtsConfigured(), engine: useVoiceConversationEngine() }))
    expect(result.current).toEqual({ available, tts: supportsTts, engine })
    unmount()
  })
})
