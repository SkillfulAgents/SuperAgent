// @vitest-environment jsdom

import { memo, useContext, useState } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The shared renderer setup stubs this module (no RouterProvider in unit
// tests); this file is about the real provider.
vi.unmock('@renderer/context/dialog-context')

const mocks = vi.hoisted(() => {
  const location = { pathname: '/', searchStr: '', search: {} as Record<string, unknown> }
  return {
    location,
    router: {
      state: { location },
      navigate: vi.fn(() => Promise.resolve()),
      history: { push: vi.fn() },
    },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => mocks.router,
}))

import { DialogContext, DialogProvider, useDialogs, type DialogContextType } from './dialog-context'

function setLocation(pathname: string, searchStr = '', search: Record<string, unknown> = {}) {
  mocks.location.pathname = pathname
  mocks.location.searchStr = searchStr
  mocks.location.search = search
}

const renders = { hook: 0, raw: 0 }
let latest: DialogContextType | null = null
const seen: DialogContextType[] = []

// Both ways the app reads the context: useDialogs() (sidebar, settings routes,
// voice button, ...) and useContext(DialogContext) (transcript links, error
// cards). memo stands in for the bail-outs between the root layout and them
// (the router's Outlet, memoized transcript rows), so only a context change
// can re-render these.
const HookConsumer = memo(function HookConsumer() {
  renders.hook++
  latest = useDialogs()
  seen.push(latest)
  return null
})

const RawConsumer = memo(function RawConsumer() {
  renders.raw++
  useContext(DialogContext)
  return null
})

let rerenderRoot: () => void = () => {}
let rootRenders = 0

/** Stands in for the root layout: re-renders on its own state, dialog state unchanged. */
function Root({ onOpenWizard }: { onOpenWizard: () => void }) {
  const [, setTick] = useState(0)
  rerenderRoot = () => setTick((t) => t + 1)
  rootRenders++
  return (
    <DialogProvider onOpenWizard={onOpenWizard}>
      <HookConsumer />
      <RawConsumer />
    </DialogProvider>
  )
}

beforeEach(() => {
  renders.hook = 0
  renders.raw = 0
  rootRenders = 0
  latest = null
  seen.length = 0
  setLocation('/')
  mocks.router.navigate.mockClear()
  mocks.router.history.push.mockClear()
})

describe('DialogProvider render stability', () => {
  it('re-renders no consumer when the root layout re-renders with unchanged dialog state', () => {
    const onOpenWizard = vi.fn()
    render(<Root onOpenWizard={onOpenWizard} />)
    expect(renders).toEqual({ hook: 1, raw: 1 })

    // A chat turn re-rendered the root layout 6-7 times.
    for (let i = 0; i < 7; i++) act(() => rerenderRoot())

    expect(rootRenders).toBe(8)
    expect(renders).toEqual({ hook: 1, raw: 1 })
    expect(new Set(seen).size).toBe(1)
  })

  it('keeps the value across a navigation: the callbacks read the location when called', () => {
    render(<Root onOpenWizard={vi.fn()} />)
    const first = latest

    setLocation('/agents/a1/sessions/s1', '?x=1', { x: 1 })
    act(() => rerenderRoot())

    expect(latest).toBe(first)
    expect(renders).toEqual({ hook: 1, raw: 1 })
  })

  it('hands consumers a new value when the wizard opener changes', () => {
    const firstOpener = vi.fn()
    const secondOpener = vi.fn()
    const { rerender } = render(<Root onOpenWizard={firstOpener} />)
    const first = latest!

    rerender(<Root onOpenWizard={secondOpener} />)

    expect(renders).toEqual({ hook: 2, raw: 2 })
    expect(latest).not.toBe(first)
    // Only the action that changed is new.
    expect(latest!.openSettings).toBe(first.openSettings)
    expect(latest!.closeSettings).toBe(first.closeSettings)
    latest!.openWizard()
    expect(secondOpener).toHaveBeenCalledTimes(1)
    expect(firstOpener).not.toHaveBeenCalled()
  })
})

describe('DialogProvider actions', () => {
  it('openSettings() navigates to /settings with the current location as the close-target', () => {
    setLocation('/agents/a1/sessions/s1', '?drawer=files', { drawer: 'files' })
    render(<Root onOpenWizard={vi.fn()} />)

    latest!.openSettings()

    expect(mocks.router.navigate).toHaveBeenCalledTimes(1)
    expect(mocks.router.navigate).toHaveBeenCalledWith({
      to: '/settings',
      search: { from: '/agents/a1/sessions/s1?drawer=files' },
    })
  })

  it('openSettings(tab) passes the tab through', () => {
    setLocation('/agents/a1')
    render(<Root onOpenWizard={vi.fn()} />)

    latest!.openSettings('llm')

    expect(mocks.router.navigate).toHaveBeenCalledWith({
      to: '/settings/$tab',
      params: { tab: 'llm' },
      search: { from: '/agents/a1' },
    })
  })

  it('openSettings() uses the location at call time, not at mount', () => {
    setLocation('/')
    render(<Root onOpenWizard={vi.fn()} />)
    const openSettings = latest!.openSettings

    setLocation('/agents/a2', '?q=1', { q: 1 })
    openSettings('voice')

    expect(mocks.router.navigate).toHaveBeenCalledWith({
      to: '/settings/$tab',
      params: { tab: 'voice' },
      search: { from: '/agents/a2?q=1' },
    })
  })

  it('openSettings() from inside settings keeps the original close-target', () => {
    setLocation('/settings/llm', '?from=%2Fagents%2Fa1', { from: '/agents/a1' })
    render(<Root onOpenWizard={vi.fn()} />)

    latest!.openSettings('voice')

    expect(mocks.router.navigate).toHaveBeenCalledWith({
      to: '/settings/$tab',
      params: { tab: 'voice' },
      search: { from: '/agents/a1' },
    })
  })

  it('openSettings() from a cold settings deep-link falls back to home', () => {
    setLocation('/settings')
    render(<Root onOpenWizard={vi.fn()} />)

    latest!.openSettings()

    expect(mocks.router.navigate).toHaveBeenCalledWith({ to: '/settings', search: { from: '/' } })
  })

  it('closeSettings() pushes the captured close-target, read at call time', () => {
    setLocation('/')
    render(<Root onOpenWizard={vi.fn()} />)
    const closeSettings = latest!.closeSettings

    setLocation('/settings/llm', '?from=%2Fagents%2Fa1%3Fdrawer%3Dfiles', { from: '/agents/a1?drawer=files' })
    closeSettings()

    expect(mocks.router.history.push).toHaveBeenCalledTimes(1)
    expect(mocks.router.history.push).toHaveBeenCalledWith('/agents/a1?drawer=files')
  })

  it('closeSettings() goes home when there is no close-target', () => {
    setLocation('/settings')
    render(<Root onOpenWizard={vi.fn()} />)

    latest!.closeSettings()

    expect(mocks.router.history.push).toHaveBeenCalledWith('/')
  })

  it('openWizard() calls the opener it was given', () => {
    const onOpenWizard = vi.fn()
    render(<Root onOpenWizard={onOpenWizard} />)

    latest!.openWizard()

    expect(onOpenWizard).toHaveBeenCalledTimes(1)
    expect(mocks.router.navigate).not.toHaveBeenCalled()
  })

  it('useDialogs() throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<HookConsumer />)).toThrow('useDialogs must be used within DialogProvider')
    spy.mockRestore()
  })
})
