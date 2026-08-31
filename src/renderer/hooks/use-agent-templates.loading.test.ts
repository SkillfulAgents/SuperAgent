import { describe, expect, it } from 'vitest'
import { isWaitingOnDiscoverableRefresh } from './use-agent-templates'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const agent = { path: 'agents/research-bot/' } as ApiDiscoverableAgent

describe('isWaitingOnDiscoverableRefresh', () => {
  it('is loading when the first catalog is empty and refresh is still pending', () => {
    expect(isWaitingOnDiscoverableRefresh([], 'pending')).toBe(true)
    expect(isWaitingOnDiscoverableRefresh([], undefined)).toBe(true)
    expect(isWaitingOnDiscoverableRefresh([], 'idle')).toBe(true)
  })

  it('is not loading after refresh settles on an empty catalog', () => {
    expect(isWaitingOnDiscoverableRefresh([], 'done')).toBe(false)
  })

  it('is not loading when the first catalog already has templates', () => {
    expect(isWaitingOnDiscoverableRefresh([agent], 'pending')).toBe(false)
  })

  it('is not loading when the catalog has not arrived yet', () => {
    expect(isWaitingOnDiscoverableRefresh(undefined, 'pending')).toBe(false)
  })
})
