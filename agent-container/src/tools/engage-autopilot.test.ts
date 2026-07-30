/**
 * The engage tool must be force-loaded (never deferred behind ToolSearch)
 * exactly when the session is in the preflight window, and stay deferred
 * otherwise. The SDK encodes force-loading as _meta['anthropic/alwaysLoad'].
 */
import { describe, it, expect } from 'vitest'
import { createEngageAutopilotTool } from './engage-autopilot'

describe('createEngageAutopilotTool', () => {
  it('stamps the alwaysLoad meta when requested', () => {
    const forced = createEngageAutopilotTool({ alwaysLoad: true })
    expect(forced.name).toBe('engage_autopilot')
    expect(forced._meta?.['anthropic/alwaysLoad']).toBe(true)
  })

  it('leaves the tool deferrable when not requested', () => {
    const deferred = createEngageAutopilotTool({ alwaysLoad: false })
    expect(deferred._meta?.['anthropic/alwaysLoad']).toBeUndefined()
  })
})
