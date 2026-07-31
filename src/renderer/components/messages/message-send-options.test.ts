import { describe, it, expect } from 'vitest'
import { buildMessageSendOptions } from './message-send-options'

describe('buildMessageSendOptions', () => {
  it('passes everything through on a fresh-turn send', () => {
    const options = { effort: 'high', speed: 'fast', model: 'claude-opus-5', autopilot: true }
    expect(buildMessageSendOptions(false, options)).toEqual(options)
  })

  it('strips model/effort/speed on a queued send but keeps the autopilot flag', () => {
    // Dropping the flag would make the server read the message as coming from
    // an autopilot-unaware surface and disengage entirely — a mid-turn message
    // with the switch ON must keep autonomy alive.
    expect(
      buildMessageSendOptions(true, { effort: 'high', model: 'claude-opus-5', autopilot: true })
    ).toEqual({ autopilot: true })
  })

  it('keeps an explicit autopilot-off on a queued send', () => {
    expect(buildMessageSendOptions(true, { effort: 'low', autopilot: false })).toEqual({
      autopilot: false,
    })
  })

  it('sends nothing on a queued send when the untouched-off switch sent nothing', () => {
    // No flag ≠ flag off: surfaces that don't know about autopilot must not
    // read as a toggle-off.
    const withoutFlag: { effort?: string; model?: string; autopilot?: boolean } = {
      effort: 'low',
      model: 'm',
    }
    expect(buildMessageSendOptions(true, withoutFlag)).toEqual({})
  })
})
