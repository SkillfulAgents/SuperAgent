import { describe, expect, it } from 'vitest'
import { detailBackLabel } from './connections-view'

describe('detailBackLabel', () => {
  const slugs = ['ada', 'ada-x1']
  it('names the agent when Back goes to its own page, whatever that page carried in its URL', () => {
    expect(detailBackLabel({ rowKey: 'account-1', source: 'home', from: '/agents/ada' }, slugs, 'Ada')).toBe('Ada')
    expect(detailBackLabel({ rowKey: 'account-1', source: 'home', from: '/agents/ada-x1?from=%2Fteam-brain' }, slugs, 'Ada')).toBe('Ada')
  })
  it('says Back for another page, and keeps the list and home labels without one', () => {
    expect(detailBackLabel({ rowKey: 'account-1', source: 'home', from: '/settings/general' }, slugs, 'Ada')).toBe('Back')
    expect(detailBackLabel({ rowKey: 'account-1', source: 'home' }, slugs, 'Ada')).toBe('Ada')
    expect(detailBackLabel({ rowKey: 'account-1', source: 'list' }, slugs, 'Ada')).toBe('Ada Connections')
  })
})
