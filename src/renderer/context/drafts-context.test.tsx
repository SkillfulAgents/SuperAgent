// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { DraftsProvider, useDraft } from './drafts-context'

function wrapper({ children }: { children: ReactNode }) {
  return createElement(DraftsProvider, null, children)
}

describe('useDraft', () => {
  it('returns undefined for an unset key', () => {
    const { result } = renderHook(() => useDraft<string>('k'), { wrapper })
    expect(result.current[0]).toBeUndefined()
  })

  it('stores and reads a value via setter', () => {
    const { result } = renderHook(() => useDraft<string>('k'), { wrapper })
    act(() => result.current[1]('hello'))
    expect(result.current[0]).toBe('hello')
  })

  it('clears the value when set to undefined', () => {
    const { result } = renderHook(() => useDraft<string>('k'), { wrapper })
    act(() => result.current[1]('hello'))
    act(() => result.current[1](undefined))
    expect(result.current[0]).toBeUndefined()
  })

  it('isolates keys — writing one does not affect another', () => {
    const { result } = renderHook(
      () => ({ a: useDraft<string>('a'), b: useDraft<string>('b') }),
      { wrapper },
    )
    act(() => result.current.a[1]('A-value'))
    expect(result.current.a[0]).toBe('A-value')
    expect(result.current.b[0]).toBeUndefined()
  })

  it('notifies subscribers of the same key across independent hooks', () => {
    const { result } = renderHook(
      () => {
        const reader = useDraft<string>('shared')
        const writer = useDraft<string>('shared')
        return { reader, writer }
      },
      { wrapper },
    )
    act(() => result.current.writer[1]('from-writer'))
    expect(result.current.reader[0]).toBe('from-writer')
  })

  it('supports non-string generics', () => {
    const { result } = renderHook(() => useDraft<{ count: number }>('obj'), { wrapper })
    act(() => result.current[1]({ count: 3 }))
    expect(result.current[0]).toEqual({ count: 3 })
  })

  it('is inert when the key is null', () => {
    const { result } = renderHook(() => useDraft<string>(null), { wrapper })
    expect(result.current[0]).toBeUndefined()
    // Setting is a no-op — should not throw and value stays undefined.
    act(() => result.current[1]('ignored'))
    expect(result.current[0]).toBeUndefined()
  })

  it('switches subscription when the key changes', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => ({
        active: useDraft<string>(key),
        a: useDraft<string>('a'),
        b: useDraft<string>('b'),
      }),
      { wrapper, initialProps: { key: 'a' } },
    )
    act(() => {
      result.current.a[1]('A')
      result.current.b[1]('B')
    })
    expect(result.current.active[0]).toBe('A')
    rerender({ key: 'b' })
    expect(result.current.active[0]).toBe('B')
  })

  it('throws when used outside a DraftsProvider', () => {
    expect(() => renderHook(() => useDraft<string>('k'))).toThrow(/DraftsProvider/)
  })
})
