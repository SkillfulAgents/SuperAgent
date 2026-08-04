// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { useRememberedFlag } from './use-remembered-flag'

beforeEach(() => {
  localStorage.clear()
  _resetApiTargetForTest()
})

afterEach(() => {
  _resetApiTargetForTest()
})

describe('useRememberedFlag', () => {
  it('shows the live answer once it arrives', () => {
    setActiveTarget('local', null)
    const { result } = renderHook(() => useRememberedFlag('marketplace', true))
    expect(result.current).toBe(true)
  })

  it('answers no for an unknown question, rather than guessing yes', () => {
    setActiveTarget('local', null)
    const { result } = renderHook(() => useRememberedFlag('marketplace', null))
    expect(result.current).toBe(false)
  })

  it('answers with last time while the question is still open', () => {
    // The point of the whole thing: no gap between the nav rendering and this
    // item joining it.
    setActiveTarget('local', null)
    renderHook(() => useRememberedFlag('marketplace', true))

    const { result } = renderHook(() => useRememberedFlag('marketplace', null))

    expect(result.current).toBe(true)
  })

  it('lets the live answer overrule what was remembered', () => {
    setActiveTarget('local', null)
    renderHook(() => useRememberedFlag('marketplace', true))

    const { result } = renderHook(() => useRememberedFlag('marketplace', false))

    expect(result.current).toBe(false)
  })

  it('does not answer for one Superagent with what it learned about the other', () => {
    // Different skillsets, different agents. A cloud workspace's marketplace is
    // no evidence about the laptop's.
    setActiveTarget('cloud', null)
    renderHook(() => useRememberedFlag('marketplace', true))

    _resetApiTargetForTest()
    setActiveTarget('local', null)
    const { result } = renderHook(() => useRememberedFlag('marketplace', null))

    expect(result.current).toBe(false)
  })

  it('remembers a no as firmly as a yes', () => {
    setActiveTarget('local', null)
    renderHook(() => useRememberedFlag('marketplace', true))
    renderHook(() => useRememberedFlag('marketplace', false))

    const { result } = renderHook(() => useRememberedFlag('marketplace', null))

    expect(result.current).toBe(false)
  })
})
