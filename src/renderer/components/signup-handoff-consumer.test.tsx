// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import { NavTransientProvider, useNavTransient } from '@renderer/context/nav-transient-context'
import { homeSearchSchema } from '@renderer/router/search-schemas'
import { lenient } from '@renderer/router/zod-search'

import { SignupHandoffConsumer } from './signup-handoff-consumer'

// Global setup stubs useNavigate to a no-op; this file needs a real router.
vi.unmock('@tanstack/react-router')

function HandoffProbe() {
  const { signupHandoff } = useNavTransient()
  return <div data-testid="handoff">{JSON.stringify(signupHandoff)}</div>
}

function makeRouter(initialEntry: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SignupHandoffConsumer />
        <HandoffProbe />
        <Outlet />
      </>
    ),
  })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: lenient(homeSearchSchema),
    component: () => <div data-testid="home">home</div>,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([homeRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
}

describe('SignupHandoffConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('moves prompt+model into the one-shot and strips those keys from the URL', async () => {
    const router = makeRouter('/?prompt=hello&model=claude-opus-5&view=graph')
    const { getByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={router} />
      </NavTransientProvider>,
    )

    await waitFor(() => {
      expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toEqual({
        prompt: 'hello',
        model: 'claude-opus-5',
      })
    })
    await waitFor(() => {
      const search = router.state.location.search as {
        prompt?: string
        model?: string
        view?: string
      }
      expect(search.prompt).toBeUndefined()
      expect(search.model).toBeUndefined()
      expect(search.view).toBe('graph')
    })
  })

  it('is a no-op when neither handoff param is present', async () => {
    const router = makeRouter('/?view=cards')
    const { getByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={router} />
      </NavTransientProvider>,
    )

    await waitFor(() => {
      expect(getByTestId('home')).toBeTruthy()
    })
    expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toBeNull()
    expect((router.state.location.search as { view?: string }).view).toBe('cards')
  })

  it('truncates prompt and drops an invalid model before writing the one-shot', async () => {
    const longPrompt = 'x'.repeat(500)
    const router = makeRouter(`/?prompt=${longPrompt}&model=${encodeURIComponent('not valid')}`)
    const { getByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={router} />
      </NavTransientProvider>,
    )

    await waitFor(() => {
      // JSON omits undefined keys — invalid model must not appear at all.
      expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toEqual({
        prompt: 'x'.repeat(400),
      })
    })
  })
})
