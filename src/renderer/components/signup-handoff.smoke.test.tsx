// @vitest-environment jsdom
/**
 * Automated Gate 2 smoke for SUP-552 PR1b — consumer validation + strip.
 * Create-form warm-start row lives in create-agent-form.handoff.test.tsx.
 */
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: true }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: { setupCompleted: true } }),
}))

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { setupCompleted: true } }),
  useUpdateUserSettings: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-agent-templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/hooks/use-agent-templates')>()
  return {
    ...actual,
    useDiscoverableAgents: () => ({ data: [], isError: false }),
  }
})
vi.mock('@renderer/hooks/use-complete-template-install', () => ({
  useCompleteTemplateInstall: () => vi.fn(),
}))
vi.mock('@renderer/components/agents/template-install-dialog', () => ({
  TemplateInstallDialog: () => null,
}))
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

describe('Gate 2 automated smoke — PR1b consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('row1 happy: prompt+model move into one-shot and leave the URL', async () => {
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

  it('row2 no-params: consumer is a no-op', async () => {
    const router = makeRouter('/?view=cards')
    const { getByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={router} />
      </NavTransientProvider>,
    )
    await waitFor(() => expect(getByTestId('home')).toBeTruthy())
    expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toBeNull()
  })

  it('row1 boundary: invalid view does not wipe a valid prompt', async () => {
    const router = makeRouter('/?prompt=keep-me&model=claude-opus-5&view=garbage')
    const { getByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={router} />
      </NavTransientProvider>,
    )
    await waitFor(() => {
      expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toEqual({
        prompt: 'keep-me',
        model: 'claude-opus-5',
      })
    })
  })
})
