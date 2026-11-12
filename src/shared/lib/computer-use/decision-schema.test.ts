import { describe, expect, it } from 'vitest'
import { computerUseDecisionSchema } from './decision-schema'

describe('computerUseDecisionSchema', () => {
  it('reads an approval with what it grants', () => {
    const body = { toolUseId: 't1', method: 'mouse-click', params: { argv: ['--xy=1,2'] }, permissionLevel: 'use_application', appName: 'Notes', grantType: 'always', grantAnyApp: true }
    expect(computerUseDecisionSchema.parse(body)).toEqual(body)
  })

  it('reads a decline', () => {
    expect(computerUseDecisionSchema.parse({ toolUseId: 't1', decline: true, declineReason: 'no' })).toEqual({ toolUseId: 't1', decline: true, declineReason: 'no' })
  })

  it.each([{}, { toolUseId: '' }, { toolUseId: 7 }, null, 'text'])('refuses %j, which names no request', (body) => {
    expect(computerUseDecisionSchema.safeParse(body).success).toBe(false)
  })

  // An approval is not lost to one odd field: it grants nothing it does not understand.
  it('drops a field of the wrong kind instead of refusing the decision', () => {
    const parsed = computerUseDecisionSchema.parse({
      toolUseId: 't1',
      method: 'click',
      params: 'nope',
      permissionLevel: 'use_any_application',
      appName: 7,
      grantType: 'forever',
      grantAnyApp: 'yes',
      decline: 'no',
    })
    expect(parsed).toEqual({ toolUseId: 't1', method: 'click' })
  })
})
