import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => state.settings,
  mutateSettings: (mutator: (settings: Record<string, unknown>) => void) => {
    mutator(state.settings)
    return state.settings
  },
}))

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import {
  clearCloudWorkspaceRecord,
  setCloudWorkspaceRecordClearedListener,
} from './cloud-workspace-record'

const RECORD = {
  deploymentUrl: 'https://ws.example.com',
  orgId: 'org_1',
  token: 'tok',
  tokenPreview: 'tok…',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  updatedAt: new Date().toISOString(),
  userId: 'usr_1',
  memberId: 'sub_1',
  tokenFingerprint: 'abc',
}

beforeEach(() => {
  state.settings = {}
  setCloudWorkspaceRecordClearedListener(null)
})

describe('clearCloudWorkspaceRecord', () => {
  it('notifies with the previous site before the record is gone', () => {
    const seen: string[] = []
    state.settings.cloudWorkspace = RECORD
    setCloudWorkspaceRecordClearedListener((url) => {
      seen.push(url)
      expect(state.settings.cloudWorkspace).toBeUndefined()
    })

    clearCloudWorkspaceRecord()

    expect(seen).toEqual(['https://ws.example.com'])
  })

  it('does not notify when nothing was stored', () => {
    const listener = vi.fn()
    setCloudWorkspaceRecordClearedListener(listener)
    clearCloudWorkspaceRecord()
    expect(listener).not.toHaveBeenCalled()
  })
})
