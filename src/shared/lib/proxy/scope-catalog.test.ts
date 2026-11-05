import { describe, expect, it } from 'vitest'
import { getScopeDescriptors } from './scope-catalog'
import { SCOPE_METADATA } from './scope-metadata'

describe('deployment scope catalog', () => {
  it('returns the complete provider metadata, including fine-grained GitHub permissions', () => {
    const descriptors = getScopeDescriptors('GitHub')
    expect(descriptors).toEqual(Object.entries(SCOPE_METADATA.github).map(([scope, meta]) => ({ scope, ...meta })))
    expect(descriptors).toContainEqual(expect.objectContaining({ scope: 'secrets:write', label: 'destructive' }))
  })

  it('resolves borrowed permissions through the same lookup as policy resolution', () => {
    expect(getScopeDescriptors('googlesheets', ['googledrive:drive.file', 'googledrive:drive.file'])).toEqual([
      { scope: 'googledrive:drive.file', ...SCOPE_METADATA.googledrive['drive.file'] },
    ])
  })

  it('keeps unknown matched scopes without guessing a risk from their name', () => {
    expect(getScopeDescriptors('new-provider', ['delete:all'], { 'delete:all': 'New capability' })).toEqual([
      { scope: 'delete:all', description: 'New capability', label: 'other' },
    ])
    expect(getScopeDescriptors('new-provider')).toEqual([])
    expect(getScopeDescriptors('github', [])).toEqual([])
  })
})
