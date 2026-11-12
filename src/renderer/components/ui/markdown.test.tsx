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
import { FilePreviewProvider, getPreviewTabKey, useFilePreview } from '@renderer/context/file-preview-context'
import { AgentMarkdown } from '@renderer/components/messages/agent-markdown'
import { Markdown } from './markdown'

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ selectedAgentSlug: 'sales-helper', view: { kind: 'session', id: 'session-1' } }),
}))

function OpenTabs() {
  return <output>{useFilePreview().openTabs.map(getPreviewTabKey).join(',')}</output>
}

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

  it('renders an unknown settings tab as plain text', () => {
    const openSettings = vi.fn()
    render(
      <DialogContext.Provider value={{ openSettings, closeSettings: vi.fn(), openWizard: vi.fn() }}>
        <Markdown>{'[Open](/settings/not-a-tab)'}</Markdown>
      </DialogContext.Provider>,
    )
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders a relative link in non-agent text as plain text', () => {
    render(<Markdown>{'[Docs](docs/setup.md)'}</Markdown>)
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
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

  it('keeps a workspace file link as a link to the file where no side panel is open', () => {
    render(<Markdown agentSlug="sales-helper">{'[Open](/workspace/output/report.md)'}</Markdown>)
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/api/agents/sales-helper/files/output/report.md')
  })

  it.each([
    ['an encoded name', '/workspace/output/Q3%20report.md', '/workspace/output/Q3 report.md'],
    ['a heading anchor', '/workspace/output/report.md#results', '/workspace/output/report.md'],
    ['a malformed escape', '/workspace/output/%FF.md', '/workspace/output/%FF.md'],
    ['its file: form', 'file:///workspace/output/report.md', '/workspace/output/report.md'],
    ['a path relative to the open file', 'notes.md', '/workspace/blog/notes.md', '/workspace/blog'],
    ['a drive path', '/mounts/Drive/report.md', '/mounts/Drive/report.md'],
  ])('opens a workspace file link with %s in the side panel', (_, href, filePath, folder?: string) => {
    render(
      <FilePreviewProvider>
        <Markdown agentSlug="sales-helper" folder={folder}>{`[Open](${href})`}</Markdown>
        <OpenTabs />
      </FilePreviewProvider>,
    )
    const link = screen.getByRole('link', { name: 'Open' })
    // A real file URL, so a middle-click or a copied link still reaches the file.
    expect(link.getAttribute('href')).toMatch(/^\/api\/agents\/sales-helper\/(mount-)?files\//)
    fireEvent.click(link)
    expect(screen.getByRole('status').textContent).toBe(`file:sales-helper:${filePath}`)
  })

  it('leaves a modifier-click on a file link to the browser', () => {
    render(
      <FilePreviewProvider>
        <Markdown agentSlug="sales-helper">{'[Open](/workspace/output/report.md)'}</Markdown>
        <OpenTabs />
      </FilePreviewProvider>,
    )
    fireEvent.click(screen.getByRole('link', { name: 'Open' }), { metaKey: true })
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('opens a folder link in the folder browser', () => {
    render(
      <FilePreviewProvider>
        <Markdown agentSlug="sales-helper">{'[Outputs](/workspace/output/)'}</Markdown>
        <OpenTabs />
      </FilePreviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Outputs' }))
    expect(screen.getByRole('status').textContent).toBe('folder:sales-helper:/workspace/output')
  })

  it.each([
    ['an encoded traversal', '/workspace/output/..%2F..%2Fetc/passwd'],
    ['a heading only', '#results'],
    ['a path outside the agent files', '/etc/passwd'],
    ['a file: path outside the agent files', 'file:///etc/passwd'],
    ['a relative path, with no file to resolve it from', 'output/report.md'],
    ['a web address with no scheme', 'github.com/acme/repo'],
    ['a source file and line', 'src/a.ts:42'],
  ])('renders a workspace link with %s as plain text', (_, href) => {
    render(
      <FilePreviewProvider>
        <Markdown agentSlug="sales-helper">{`[Open](${href})`}</Markdown>
      </FilePreviewProvider>,
    )
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it.each([
    ['with no link handler of its own', undefined],
    ['whose own link handler passes on it', () => null],
  ])('opens an agent file link from agent text %s', (_, link) => {
    render(
      <FilePreviewProvider>
        <AgentMarkdown text="[Open](/workspace/output/report.md)" mode="settled" agentSlug="sales-helper" link={link} />
        <OpenTabs />
      </FilePreviewProvider>,
    )
    fireEvent.click(screen.getByRole('link', { name: 'Open' }))
    expect(screen.getByRole('status').textContent).toBe('file:sales-helper:/workspace/output/report.md')
  })

  it('never hands a file link to a caller\'s link handler', () => {
    const link = vi.fn((_href: string | undefined) => null)
    render(<AgentMarkdown text="[Open](/workspace/output/report.md) [Docs](notes.md)" mode="settled" agentSlug="sales-helper" link={link} />)
    expect(link.mock.calls.map(([href]) => href)).toEqual(['notes.md'])
  })

  it('keeps a protocol-relative web link as a link', () => {
    render(<Markdown agentSlug="sales-helper">{'[Site](//example.com/a)'}</Markdown>)
    expect(screen.getByRole('link', { name: 'Site' })).toHaveAttribute('target', '_blank')
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
