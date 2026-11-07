// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const { mockNavigate, location } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  location: { pathname: '/', search: {} as Record<string, unknown>, searchStr: '' },
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ state: { location }, navigate: mockNavigate }),
}))

import { useOpenCreateAgent } from './use-open-create-agent'

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(location, { pathname: '/', search: {}, searchStr: '' })
})

describe('useOpenCreateAgent', () => {
  it('opens the create page with the current location as its Back target', () => {
    Object.assign(location, { pathname: '/agents/alpha', searchStr: '?view=graph' })
    const { result } = renderHook(() => useOpenCreateAgent())
    result.current({ surface: 'nav' })
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/new-agent',
      search: { from: '/agents/alpha?view=graph', section: undefined, surface: 'nav' },
    })
  })

  it('carries the section whose + was pressed', () => {
    const { result } = renderHook(() => useOpenCreateAgent())
    result.current({ surface: 'section_plus', folderId: 'f1' })
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/new-agent',
      search: { from: '/', section: 'f1', surface: 'section_plus' },
    })
  })

  it('opens the template page for Browse Templates', () => {
    const { result } = renderHook(() => useOpenCreateAgent())
    result.current({ surface: 'home', start: 'templates' })
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/new-agent/templates',
      search: { from: '/', section: undefined, surface: 'home' },
    })
  })

  it('keeps the original Back target when opened again from the page itself', () => {
    Object.assign(location, {
      pathname: '/new-agent',
      search: { from: '/notifications', surface: 'nav' },
      searchStr: '?from=%2Fnotifications&surface=nav',
    })
    const { result } = renderHook(() => useOpenCreateAgent())
    result.current({ surface: 'app_menu' })
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/new-agent',
      search: { from: '/notifications', section: undefined, surface: 'app_menu' },
    })
  })
})
