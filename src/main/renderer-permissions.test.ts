import { describe, it, expect } from 'vitest'
import { isAllowedRendererPermission } from './renderer-permissions'

describe('isAllowedRendererPermission', () => {
  it('allows fullscreen so the video preview can enter full screen', () => {
    expect(isAllowedRendererPermission('fullscreen')).toBe(true)
  })

  it('keeps allowing microphone and clipboard access', () => {
    expect(isAllowedRendererPermission('media')).toBe(true)
    expect(isAllowedRendererPermission('clipboard-read')).toBe(true)
  })

  it('denies permissions outside the list', () => {
    expect(isAllowedRendererPermission('geolocation')).toBe(false)
    expect(isAllowedRendererPermission('notifications')).toBe(false)
  })
})
