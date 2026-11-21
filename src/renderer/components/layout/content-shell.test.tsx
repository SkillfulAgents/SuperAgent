// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { ContentBackdrop, ContentCanvas, ContentShell } from './content-shell'

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

describe('ContentShell floating header', () => {
  it('draws a solid header with a line under it by default', () => {
    renderShell(<div>Home</div>)
    const header = screen.getByTestId('main-content').querySelector('header')!
    expect(header).toHaveClass('border-b')
    expect(header).not.toHaveAttribute('data-floating')
  })

  it('floats a glass header over the body, which it pushes down by its height and lets reach up behind it', () => {
    render(
      <SidebarProvider>
        <ContentShell needsTrafficLightPadding={false} headerContent={null} floatingHeader>
          <div>Session</div>
        </ContentShell>
      </SidebarProvider>,
    )
    const shell = screen.getByTestId('main-content')
    const header = shell.querySelector('header')!
    expect(header).toHaveAttribute('data-floating')
    expect(header).toHaveClass('absolute', 'backdrop-blur-md')
    expect(header).toHaveClass('border-b', 'border-border/50')
    expect(shell).toHaveClass('floating-header-shell')
    expect(shell.style.getPropertyValue('--floating-header')).toBe('48px')
    expect(shell.style.paddingTop).toBe('48px')
  })
})

describe('ContentShell canvas', () => {
  it('lays the off-white page under the shell only while a view asks for it', () => {
    const { rerender } = renderShell(<div>Settings</div>)
    expect(screen.getByTestId('main-content')).not.toHaveClass('bg-canvas')
    rerender(
      <SidebarProvider>
        <ContentShell needsTrafficLightPadding={false} headerContent={null}>
          <ContentCanvas />
        </ContentShell>
      </SidebarProvider>,
    )
    expect(screen.getByTestId('main-content')).toHaveClass('bg-canvas')
    // The header takes the page's colour with it.
    expect(screen.getByTestId('main-content').querySelector('header')).toHaveClass('bg-canvas')
  })

  it('paints a floating header in the page colour as glass', () => {
    render(
      <SidebarProvider>
        <ContentShell needsTrafficLightPadding={false} headerContent={null} floatingHeader>
          <ContentCanvas />
        </ContentShell>
      </SidebarProvider>,
    )
    const header = screen.getByTestId('main-content').querySelector('header')!
    expect(header).toHaveClass('bg-canvas/85', 'supports-[backdrop-filter]:bg-canvas/65')
    expect(header).not.toHaveClass('bg-background/85')
  })
})
