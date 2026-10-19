// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { DialogContext } from '@renderer/context/dialog-context'
import { Markdown } from './markdown'

describe('Markdown', () => {
  afterEach(cleanup)

  it('opens links in a new window with noopener by default', () => {
    render(<Markdown>[Docs](https://example.com/docs)</Markdown>)
    const link = screen.getByRole('link', { name: 'Docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('opens a settings tab link in the app', () => {
    const openSettings = vi.fn()
    render(
      <DialogContext.Provider value={{ openSettings, closeSettings: vi.fn(), openWizard: vi.fn() }}>
        <Markdown>{'Browser use is off. [Open Browser settings](/settings/browser)'}</Markdown>
      </DialogContext.Provider>,
    )
    const link = screen.getByRole('link', { name: 'Open Browser settings' })
    expect(link).not.toHaveAttribute('target')
    fireEvent.click(link)
    expect(openSettings).toHaveBeenCalledWith('browser')
  })

  it('keeps an unknown settings tab as an external link', () => {
    const openSettings = vi.fn()
    render(
      <DialogContext.Provider value={{ openSettings, closeSettings: vi.fn(), openWizard: vi.fn() }}>
        <Markdown>{'[Open](/settings/not-a-tab)'}</Markdown>
      </DialogContext.Provider>,
    )
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('target', '_blank')
  })

  it('navigates an agent page link in the app', async () => {
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Markdown>{'Add the key on the [Secrets page](/agents/sales-helper/secrets).'}</Markdown>
          <Outlet />
        </>
      ),
    })
    const secretsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: 'agents/$slug/secrets',
      component: () => <p>Secrets for sales-helper</p>,
    })
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, secretsRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)

    const link = await screen.findByRole('link', { name: 'Secrets page' })
    expect(link).not.toHaveAttribute('target')
    fireEvent.click(link)
    expect(await screen.findByText('Secrets for sales-helper')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agents/sales-helper/secrets')
  })

  it.each([
    ['an unknown agent page', '[Open](/agents/sales-helper/not-a-page)'],
    ['a placeholder slug', '[Open](/agents/<slug>/secrets)'],
  ])('renders %s as plain text', (_, markdown) => {
    render(<Markdown>{markdown}</Markdown>)
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('applies the shared plugins: GFM autolinks with fullwidth trail handling', () => {
    const { container } = render(<Markdown>Pushed to **https://github.com/acme/widget-kit**（public）。</Markdown>)
    expect(container.querySelector('strong a')).toHaveAttribute('href', 'https://github.com/acme/widget-kit')
  })

  it('merges caller components over the defaults', () => {
    const components = { a: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button> }
    render(<Markdown components={components}>[Go](https://example.com) **b**</Markdown>)
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
