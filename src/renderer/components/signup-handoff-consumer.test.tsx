// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const completeInstall = vi.fn()
const mutateAsync = vi.fn()
const toastError = vi.fn()
let mockDiscoverableAgents: ApiDiscoverableAgent[] | undefined
let mockDiscoverableAgentsFailed = false
let mockSetupCompleted = true
let mockGlobalSetupCompleted = true
let mockIsAuthMode = true

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: mockIsAuthMode }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: { setupCompleted: mockGlobalSetupCompleted } }),
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { setupCompleted: mockSetupCompleted } }),
  useUpdateUserSettings: () => ({ mutateAsync }),
}))
vi.mock('@renderer/hooks/use-agent-templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/hooks/use-agent-templates')>()
  return {
    ...actual,
    useDiscoverableAgents: () => ({ data: mockDiscoverableAgents, isError: mockDiscoverableAgentsFailed }),
  }
})
vi.mock('@renderer/hooks/use-complete-template-install', () => ({
  useCompleteTemplateInstall: () => completeInstall,
}))
vi.mock('@renderer/components/agents/template-install-dialog', () => ({
  TemplateInstallDialog: ({
    template,
    onInstalled,
  }: {
    template: ApiDiscoverableAgent | null
    onInstalled: (agent: { slug: string }) => void | Promise<void>
  }) => {
    if (!template) return null
    return (
      <button type="button" data-testid="template-install-dialog" onClick={() => void onInstalled({ slug: 'seo-agent' })}>
        {template.name}
      </button>
    )
  },
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

const match: ApiDiscoverableAgent = {
  skillsetId: DEFAULT_PUBLIC_SKILLSET.id,
  skillsetName: 'Public',
  name: 'SEO Agent',
  description: 'seo',
  version: '1.0.0',
  path: 'agents/seo-agent/',
}

describe('SignupHandoffConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDiscoverableAgents = []
    mockDiscoverableAgentsFailed = false
    mockSetupCompleted = true
    mockGlobalSetupCompleted = true
    mockIsAuthMode = true
    completeInstall.mockResolvedValue(undefined)
    mutateAsync.mockResolvedValue({})
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

  it('moves template_slug into the one-shot and strips it alongside prompt and model', async () => {
    const router = makeRouter('/?prompt=hello&model=claude-opus-5&template_slug=my-bot')
    const { getByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={router} />
      </NavTransientProvider>,
    )

    await waitFor(() => {
      expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toEqual({
        prompt: 'hello',
        model: 'claude-opus-5',
        template_slug: 'my-bot',
      })
    })
    await waitFor(() => {
      const search = router.state.location.search as Record<string, unknown>
      expect(search.prompt).toBeUndefined()
      expect(search.model).toBeUndefined()
      expect(search.template_slug).toBeUndefined()
    })
  })

  it('completed first-run keeps a slug-only handoff after stripping the URL', async () => {
    const router = makeRouter('/?template_slug=research-agent')
    const { getByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={router} />
      </NavTransientProvider>,
    )

    await waitFor(() => {
      expect((router.state.location.search as { template_slug?: string }).template_slug).toBeUndefined()
    })
    expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toEqual({
      template_slug: 'research-agent',
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

function renderSlugFirstRun(slug = 'seo-agent') {
  mockSetupCompleted = false
  const router = makeRouter(`/?template_slug=${slug}`)
  return render(
    <NavTransientProvider>
      <RouterProvider router={router} />
    </NavTransientProvider>,
  )
}

describe('SignupHandoffConsumer template-only first run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDiscoverableAgents = undefined
    mockDiscoverableAgentsFailed = false
    mockSetupCompleted = false
    mockGlobalSetupCompleted = true
    mockIsAuthMode = true
    completeInstall.mockResolvedValue(undefined)
    mutateAsync.mockResolvedValue({})
  })

  it('match → opens the install dialog; complete then writes setupCompleted', async () => {
    mockDiscoverableAgents = [match]
    const { getByTestId } = renderSlugFirstRun()
    await waitFor(() => expect(getByTestId('template-install-dialog')).toHaveTextContent('SEO Agent'))
    getByTestId('template-install-dialog').click()
    await waitFor(() => expect(completeInstall).toHaveBeenCalledWith({ slug: 'seo-agent' }))
    expect(mutateAsync).toHaveBeenCalledWith({ setupCompleted: true, onboardingProgress: null })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('populated, no match → toast, no dialog', async () => {
    mockDiscoverableAgents = [{ ...match, path: 'agents/other/' }]
    const { queryByTestId } = renderSlugFirstRun()
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't load that template", expect.anything()))
    expect(queryByTestId('template-install-dialog')).toBeNull()
    expect(completeInstall).not.toHaveBeenCalled()
  })

  it('catalog error → toast, no dialog', async () => {
    mockDiscoverableAgentsFailed = true
    renderSlugFirstRun()
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(completeInstall).not.toHaveBeenCalled()
  })

  it('setup write fails after install → toast, agent already handed off', async () => {
    mockDiscoverableAgents = [match]
    mutateAsync.mockRejectedValue(new Error('PUT failed'))
    const { getByTestId } = renderSlugFirstRun()
    await waitFor(() => expect(getByTestId('template-install-dialog')).toBeInTheDocument())
    getByTestId('template-install-dialog').click()
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Agent installed, but setup status could not be saved.', expect.anything()))
    expect(completeInstall).toHaveBeenCalled()
  })

  it('prompt + slug first-run → no install, one-shot keeps both', async () => {
    mockDiscoverableAgents = [match]
    const router = makeRouter('/?prompt=hello&template_slug=seo-agent')
    const { getByTestId, queryByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={router} />
      </NavTransientProvider>,
    )
    await waitFor(() => {
      expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toEqual({
        prompt: 'hello',
        template_slug: 'seo-agent',
      })
    })
    expect(queryByTestId('template-install-dialog')).toBeNull()
    expect(completeInstall).not.toHaveBeenCalled()
  })

  it('already finished first-run → no install', async () => {
    mockSetupCompleted = true
    mockDiscoverableAgents = [match]
    const { queryByTestId } = render(
      <NavTransientProvider>
        <RouterProvider router={makeRouter('/?template_slug=seo-agent')} />
      </NavTransientProvider>,
    )
    await waitFor(() => expect(queryByTestId('home')).toBeTruthy())
    expect(queryByTestId('template-install-dialog')).toBeNull()
    expect(completeInstall).not.toHaveBeenCalled()
  })

  it('global setup incomplete → leaves the handoff for the full wizard', async () => {
    mockGlobalSetupCompleted = false
    mockDiscoverableAgents = [match]
    const { getByTestId, queryByTestId } = renderSlugFirstRun()
    await waitFor(() => {
      expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toEqual({
        template_slug: 'seo-agent',
      })
    })
    expect(queryByTestId('template-install-dialog')).toBeNull()
    expect(completeInstall).not.toHaveBeenCalled()
  })

  it('local first run → leaves the handoff for the full wizard', async () => {
    mockIsAuthMode = false
    mockDiscoverableAgents = [match]
    const { getByTestId, queryByTestId } = renderSlugFirstRun()
    await waitFor(() => {
      expect(JSON.parse(getByTestId('handoff').textContent ?? 'null')).toEqual({
        template_slug: 'seo-agent',
      })
    })
    expect(queryByTestId('template-install-dialog')).toBeNull()
    expect(completeInstall).not.toHaveBeenCalled()
  })
})
