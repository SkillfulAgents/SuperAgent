// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { ContentBackdrop, ContentShell } from './content-shell'

function renderShell(children: React.ReactNode) {
  return render(
    <SidebarProvider>
      <ContentShell needsTrafficLightPadding={false} headerContent={<span>Header</span>}>{children}</ContentShell>
    </SidebarProvider>,
  )
}

// A backdrop-filter costs a filter pass per frame even over a flat canvas; on
// the session page that pushed the WebKit CI VM into shutdowns (since #1797).
describe('ContentShell glass', () => {
  it('keeps the header solid when nothing is painted behind it', () => {
    renderShell(<div>Session</div>)
    const shell = screen.getByTestId('main-content')
    expect(shell.hasAttribute('data-backdrop')).toBe(false)
    const header = shell.querySelector('header')!
    expect(header.className).toContain('bg-background')
    expect(header.className).not.toContain('backdrop-blur')
  })

  it('turns the header to glass while a backdrop is mounted, and back when it leaves', () => {
    const { rerender } = renderShell(<ContentBackdrop><div data-testid="halftone" /></ContentBackdrop>)
    const shell = screen.getByTestId('main-content')
    expect(screen.getByTestId('halftone')).toBeTruthy()
    expect(shell.hasAttribute('data-backdrop')).toBe(true)
    expect(shell.querySelector('header')!.className).toContain('backdrop-blur-xl')

    rerender(
      <SidebarProvider>
        <ContentShell needsTrafficLightPadding={false} headerContent={<span>Header</span>}><div>Session</div></ContentShell>
      </SidebarProvider>,
    )
    expect(shell.hasAttribute('data-backdrop')).toBe(false)
    expect(shell.querySelector('header')!.className).not.toContain('backdrop-blur')
  })
})
