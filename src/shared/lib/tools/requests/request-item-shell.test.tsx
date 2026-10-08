// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
import { PendingRequestStack } from './pending-request-stack'
import { HelpCircle, Key, Terminal } from 'lucide-react'

describe('RequestItemShell', () => {
  describe('opaque card background', () => {
    it.each([
      {
        state: 'pending',
        props: {},
      },
      {
        state: 'read-only',
        props: { readOnly: {} },
      },
      {
        state: 'completed',
        props: {
          completed: {
            icon: <Key />,
            label: 'API_KEY',
            statusLabel: 'Provided',
            isSuccess: true,
          },
        },
      },
    ])('uses the opaque card token in the $state state', ({ props }) => {
      render(
        <RequestItemShell
          title="Test Request"
          theme="blue"
          data-testid="request-card"
          {...props}
        >
          <div>Content</div>
        </RequestItemShell>
      )

      expect(screen.getByTestId('request-card')).toHaveClass('bg-card')
      expect(screen.getByTestId('request-card')).not.toHaveClass('bg-muted/30')
    })
  })

  describe('pending state (default)', () => {
    it('renders title chip and children', () => {
      render(
        <RequestItemShell title="Test Request" icon={<HelpCircle />} theme="blue">
          <div data-testid="child-content">Hello</div>
        </RequestItemShell>
      )

      expect(screen.getByText('Test Request')).toBeInTheDocument()
      expect(screen.getByTestId('child-content')).toBeInTheDocument()
    })

    it('passes through data attributes', () => {
      render(
        <RequestItemShell
          title="Test"
          icon={<HelpCircle />}
          theme="blue"
          data-testid="my-request"
          data-status="pending"
        >
          <div>Content</div>
        </RequestItemShell>
      )

      expect(screen.getByTestId('my-request')).toBeInTheDocument()
      expect(screen.getByTestId('my-request')).toHaveAttribute('data-status', 'pending')
    })

    it('renders error message when error prop is set', () => {
      render(
        <RequestItemShell title="Test" icon={<HelpCircle />} theme="blue" error="Something failed">
          <div>Content</div>
          <RequestItemActions>
            <button type="button">Submit</button>
          </RequestItemActions>
        </RequestItemShell>
      )

      expect(screen.getByText(/Something failed/)).toBeInTheDocument()
    })

    it('does not render error when error is null', () => {
      render(
        <RequestItemShell title="Test" icon={<HelpCircle />} theme="blue" error={null}>
          <div>Content</div>
          <RequestItemActions>
            <button type="button">Submit</button>
          </RequestItemActions>
        </RequestItemShell>
      )

      expect(screen.queryByText(/Error:/)).not.toBeInTheDocument()
    })

    it('keeps actions in a normal footer outside the scrollable card body', () => {
      render(
        <RequestItemShell
          title="Tall request"
          theme="orange"
          data-testid="request-card"
        >
          <div data-testid="long-content">Long content</div>
          <RequestItemActions>
            <button type="button">Allow</button>
          </RequestItemActions>
        </RequestItemShell>
      )

      const card = screen.getByTestId('request-card')
      const body = card.querySelector<HTMLElement>('[data-request-item-body]')
      const actions = card.querySelector<HTMLElement>('[data-request-item-actions="footer"]')

      expect(card).toHaveClass('flex', 'flex-col', 'overflow-hidden')
      expect(card).not.toHaveClass('overflow-y-auto')
      expect(body).toHaveClass('min-h-0', 'overflow-y-auto')
      expect(body).toContainElement(screen.getByTestId('long-content'))
      expect(body).not.toContainElement(actions)
      expect(actions).not.toHaveClass('sticky')
      expect(actions?.parentElement).toBe(card)
    })

    it('leaves explicitly inline actions inside the scrollable body', () => {
      render(
        <RequestItemShell title="Inline request" theme="blue" data-testid="request-card">
          <div>
            <RequestItemActions inline>
              <button type="button">Connect</button>
            </RequestItemActions>
          </div>
        </RequestItemShell>
      )

      const card = screen.getByTestId('request-card')
      const body = card.querySelector<HTMLElement>('[data-request-item-body]')
      const actions = card.querySelector<HTMLElement>('[data-request-item-actions="inline"]')

      expect(body).toContainElement(actions)
      expect(card.querySelector('[data-request-item-actions="footer"]')).toBeNull()
    })

    it('renders headerRight content', () => {
      render(
        <RequestItemShell
          title="Test"
          icon={<HelpCircle />}
          theme="blue"
          headerRight={<span data-testid="header-right">Extra</span>}
        >
          <div>Content</div>
        </RequestItemShell>
      )

      expect(screen.getByTestId('header-right')).toBeInTheDocument()
    })
  })

  describe('completed state', () => {
    it('renders compact completed row', () => {
      render(
        <RequestItemShell
          title="Secret Request"
          icon={<Key />}
          theme="orange"
          completed={{
            icon: <Key data-testid="completed-icon" className="text-green-500" />,
            label: <span>API_KEY</span>,
            statusLabel: 'Provided',
            isSuccess: true,
          }}
        >
          <div data-testid="pending-content">Should not render</div>
        </RequestItemShell>
      )

      expect(screen.getByText('API_KEY')).toBeInTheDocument()
      expect(screen.getByText('Provided')).toBeInTheDocument()
      expect(screen.getByTestId('completed-icon')).toBeInTheDocument()
      // Children should NOT render in completed state
      expect(screen.queryByTestId('pending-content')).not.toBeInTheDocument()
    })

    it('shows green status for success', () => {
      render(
        <RequestItemShell
          title="Test"
          icon={<Terminal />}
          theme="orange"
          completed={{
            icon: <Terminal />,
            label: 'Script',
            statusLabel: 'Executed',
            isSuccess: true,
          }}
        >
          <div />
        </RequestItemShell>
      )

      const status = screen.getByText('Executed')
      expect(status.className).toContain('text-green-600')
    })

    it('shows red status for failure', () => {
      render(
        <RequestItemShell
          title="Test"
          icon={<Terminal />}
          theme="orange"
          completed={{
            icon: <Terminal />,
            label: 'Script',
            statusLabel: 'Denied',
            isSuccess: false,
          }}
        >
          <div />
        </RequestItemShell>
      )

      const status = screen.getByText('Denied')
      expect(status.className).toContain('text-red-600')
    })
  })

  describe('read-only state', () => {
    it('renders read-only view with waiting text', () => {
      render(
        <RequestItemShell
          title="Script Execution Request"
          icon={<Terminal />}
          theme="orange"
          readOnly={{ description: <p>Run a script</p> }}
          waitingText="Waiting for approval"
        >
          <div data-testid="pending-content">Should not render</div>
        </RequestItemShell>
      )

      expect(screen.getByText('Script Execution Request')).toBeInTheDocument()
      expect(screen.getByText('Run a script')).toBeInTheDocument()
      expect(screen.getByText('Waiting for approval')).toBeInTheDocument()
      // Children should NOT render in read-only state
      expect(screen.queryByTestId('pending-content')).not.toBeInTheDocument()
    })

    it('renders extra content in read-only mode', () => {
      render(
        <RequestItemShell
          title="Test"
          icon={<HelpCircle />}
          theme="blue"
          readOnly={{
            description: <p>Description</p>,
            extraContent: <div data-testid="extra">Extra stuff</div>,
          }}
        >
          <div />
        </RequestItemShell>
      )

      expect(screen.getByTestId('extra')).toBeInTheDocument()
    })

    it('uses default waiting text', () => {
      render(
        <RequestItemShell
          title="Test"
          icon={<HelpCircle />}
          theme="blue"
          readOnly={{}}
        >
          <div />
        </RequestItemShell>
      )

      expect(screen.getByText('Waiting for response')).toBeInTheDocument()
    })
  })

  describe('pagination controls', () => {
    it('shows pagination controls when inside a stack with multiple children', () => {
      render(
        <PendingRequestStack>
          {[
            <RequestItemShell key="a" title="Request A" icon={<HelpCircle />} theme="blue">
              <div>Content A</div>
            </RequestItemShell>,
            <RequestItemShell key="b" title="Request B" icon={<HelpCircle />} theme="blue">
              <div>Content B</div>
            </RequestItemShell>,
          ]}
        </PendingRequestStack>
      )

      // Both cards render pagination (both in DOM, one hidden via CSS)
      const paginationTexts = screen.getAllByText('1 of 2')
      expect(paginationTexts.length).toBeGreaterThan(0)
    })

    it('does not show pagination controls for a single item', () => {
      render(
        <PendingRequestStack>
          {[
            <RequestItemShell key="a" title="Request A" icon={<HelpCircle />} theme="blue">
              <div>Content A</div>
            </RequestItemShell>,
          ]}
        </PendingRequestStack>
      )

      expect(screen.queryByText(/of/)).not.toBeInTheDocument()
    })

    it('does not show pagination controls outside a stack', () => {
      render(
        <RequestItemShell title="Request" icon={<HelpCircle />} theme="blue">
          <div>Content</div>
        </RequestItemShell>
      )

      expect(screen.queryByText(/of/)).not.toBeInTheDocument()
    })
  })

  // Pins the fix site: a dual per-card patch that leaves the shell as plain text
  // would still green the question-card regression, but fails here.
  describe('title linkify', () => {
    it('renders a bare URL in a string title as a clickable link', () => {
      const url = 'https://app.clay.com/oauth/device?user_code=LCWW-PKKC'
      render(
        <RequestItemShell title={`Open this URL: ${url}`} theme="blue">
          <div />
        </RequestItemShell>
      )

      expect(screen.getByRole('link', { name: url })).toHaveAttribute('href', url)
    })

    it('does not interpret markdown in a string title', () => {
      // Rejected shape A (MarkdownBlock) would bold this and collapse the blank line.
      render(
        <RequestItemShell
          title={'Line one\n\n**not bold** https://example.com/path'}
          theme="blue"
        >
          <div />
        </RequestItemShell>
      )

      expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/path')
      expect(screen.getByText(/\*\*not bold\*\*/)).toBeInTheDocument()
      expect(document.querySelector('strong')).toBeNull()
    })
  })
})
