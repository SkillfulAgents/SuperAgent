import { describe, expect, it } from 'vitest'
import { LinearParticipation } from './participation'
import { linearParticipationSchema, MAX_LINEAR_PARTICIPATION } from './config'
const identity = { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app', appName: 'Agent' }
describe('Linear thread participation', () => {
  it('preserves joined threads but isolates app identities and workspaces', () => {
    const state = new LinearParticipation(identity)
    state.remember('issue', 'root'); state.remember('issue', 'other')
    const stored = linearParticipationSchema.parse(state.snapshot())
    expect(new LinearParticipation(identity, stored).get('issue')).toEqual(new Set(['root', 'other']))
    expect(new LinearParticipation({ ...identity, appUserId: 'replacement' }, stored).get('issue')).toBeUndefined()
    expect(new LinearParticipation({ ...identity, workspaceId: 'other' }, stored).get('issue')).toBeUndefined()
  })
  it('bounds retained threads and removes an issue when its last entry is evicted', () => {
    const state = new LinearParticipation(identity)
    state.remember('old-issue', 'root')
    for (let i = 0; i < MAX_LINEAR_PARTICIPATION; i++) state.remember('issue', String(i))
    expect(state.get('old-issue')).toBeUndefined()
    expect(state.get('issue')?.size).toBe(MAX_LINEAR_PARTICIPATION)
    expect(linearParticipationSchema.parse(state.snapshot()).threads).toHaveLength(MAX_LINEAR_PARTICIPATION)
    expect(state.remember('issue', '0')).toBe(false)
  })
})
