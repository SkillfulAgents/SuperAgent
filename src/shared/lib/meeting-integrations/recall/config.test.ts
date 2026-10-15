import { describe, expect, it } from 'vitest'
import { mergeRecallConfig, parseRecallConfig, recallConfigSchema, recallSettingsOf, recallSettingsPatchSchema } from './config'
import { MEETING_INSTRUCTIONS_MAX_CHARS } from '../schemas'

describe('recall config', () => {
  it('stores a name and standing instructions, both optional and trimmed', () => {
    expect(recallConfigSchema.parse({})).toEqual({})
    expect(recallConfigSchema.parse({ botName: ' Ada ', instructions: ' Keep it short. ' })).toEqual({ botName: 'Ada', instructions: 'Keep it short.' })
    expect(recallConfigSchema.safeParse({ instructions: 'x'.repeat(MEETING_INSTRUCTIONS_MAX_CHARS + 1) }).success).toBe(false)
    expect(recallConfigSchema.safeParse({ apiKey: 'k' }).success).toBe(false)
  })

  it('reads stored rows, dropping spike-era credentials and empty fields', () => {
    expect(parseRecallConfig('{"apiKey":"k","region":"us-west-2","botName":"Ada"}')).toEqual({ botName: 'Ada' })
    expect(parseRecallConfig('{"botName":"","instructions":"Say hi."}')).toEqual({ instructions: 'Say hi.' })
    expect(() => parseRecallConfig('not json')).toThrow(/Invalid stored/)
    expect(recallSettingsOf('{"botName":"Ada"}')).toEqual({ botName: 'Ada', instructions: null, mode: 'voice', voice: null })
    expect(recallSettingsOf('broken')).toEqual({ botName: null, instructions: null, mode: 'voice', voice: null })
  })

  it('patches clear a field with null and leave absent fields alone', () => {
    expect(recallSettingsPatchSchema.parse({ instructions: null })).toEqual({ instructions: null })
    expect(recallSettingsPatchSchema.parse({ botName: 'Ada' })).toEqual({ botName: 'Ada' })
    expect(recallSettingsPatchSchema.safeParse({ botName: '' }).success).toBe(false)
    expect(recallSettingsPatchSchema.safeParse({ region: 'eu' }).success).toBe(false)
  })

  it('stores how the agent takes part and which voice it uses, with the family defaults when unset', () => {
    expect(recallConfigSchema.parse({ mode: 'silent', voice: 'cinder' })).toEqual({ mode: 'silent', voice: 'cinder' })
    expect(recallConfigSchema.safeParse({ mode: 'loud' }).success).toBe(false)
    expect(recallSettingsOf('{}')).toEqual({ botName: null, instructions: null, mode: 'voice', voice: null })
    expect(recallSettingsOf('{"mode":"listen","voice":"cinder"}')).toMatchObject({ mode: 'listen', voice: 'cinder' })
    expect(mergeRecallConfig('{"mode":"listen","voice":"cinder"}', { voice: null, mode: 'voice' })).toEqual({ mode: 'voice' })
  })

  it('merges a patch into the stored row for the service: set, keep, clear', () => {
    const stored = '{"apiKey":"old","botName":"Ada","instructions":"Keep it short."}'
    expect(mergeRecallConfig(stored, { instructions: 'Track action items.' })).toEqual({ botName: 'Ada', instructions: 'Track action items.' })
    expect(mergeRecallConfig(stored, { botName: null })).toEqual({ instructions: 'Keep it short.' })
    expect(mergeRecallConfig(stored, {})).toEqual({ botName: 'Ada', instructions: 'Keep it short.' })
    expect(() => mergeRecallConfig(stored, { apiKey: 'new' })).toThrow()
  })
})
