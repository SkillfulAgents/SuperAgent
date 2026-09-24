// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProviderSelect } from './provider-select'
import { connectionInfoSchema } from '@shared/lib/llm-provider/connection-schema'
import { usageSnapshot } from '@shared/lib/llm-provider/usage-schema'
const usageReads = vi.hoisted(() => vi.fn())
vi.mock('@renderer/hooks/use-provider-usage', () => ({
  supportsUsage: () => true,
  useProviderUsage: () => { usageReads(); return ({ data: usageSnapshot([
    { kind: 'window', id: 'short', label: '5h', usedPercent: 100 },
    { kind: 'window', id: 'long', label: 'Weekly', usedPercent: 85 },
  ]) }) },
}))
const connections = ['Codex', 'Grok'].map(name => connectionInfoSchema.parse({ id: name, name, provider: 'codex-subscription', userId: null, ownerName: null, managed: false, isConfigured: true, catalog: [], modelOverrides: [], defaultModel: null, browserModel: null, dashboardModel: null, canManage: true, canDelete: true }))
beforeEach(() => {
  usageReads.mockClear()
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.scrollIntoView = () => {}
})
describe('provider dropdown with usage', () => {
  it('shows separate compact windows and allows selecting an exhausted provider', async () => {
    const onChange = vi.fn()
    render(<ProviderSelect connections={connections} value="Codex" onChange={onChange} />)
    expect(usageReads).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('option', { name: 'Codex' })).toHaveAccessibleDescription('5h: 100% used; Weekly: 85% used')
    expect(screen.getByRole('option', { name: 'Grok' })).toHaveAccessibleDescription('5h: 100% used; Weekly: 85% used')
    await userEvent.click(screen.getByRole('option', { name: /Grok/ }))
    expect(onChange).toHaveBeenCalledWith('Grok')
    expect(screen.getByRole('combobox')).not.toHaveTextContent('Weekly')
    usageReads.mockClear()
    expect(screen.queryByText('5h: 100% used; Weekly: 85% used')).not.toBeInTheDocument()
    expect(usageReads).not.toHaveBeenCalled()
  })
  it('keeps rows above the highlight open until the pointer leaves, collapsing rows below at once', async () => {
    const three = [...connections, connectionInfoSchema.parse({ ...connections[0], id: 'Platform', name: 'Platform' })]
    render(<ProviderSelect connections={three} value="Codex" onChange={vi.fn()} />)
    await userEvent.click(screen.getByRole('combobox'))
    const open = () => three.filter(c => screen.getByRole('option', { name: c.name }).querySelector('[data-expanded]')).map(c => c.name)
    fireEvent.focus(screen.getByRole('option', { name: 'Grok' }))
    fireEvent.focus(screen.getByRole('option', { name: 'Platform' }))
    expect(open()).toEqual(['Codex', 'Grok', 'Platform'])
    fireEvent.focus(screen.getByRole('option', { name: 'Grok' }))
    expect(open()).toEqual(['Codex', 'Grok'])
    fireEvent.pointerLeave(screen.getByRole('listbox'))
    expect(open()).toEqual([])
  })
  it('always lists Platform first', async () => {
    const platform = connectionInfoSchema.parse({ ...connections[0], id: 'Platform', name: 'Platform', provider: 'platform' })
    render(<ProviderSelect connections={[...connections, platform]} value="Codex" onChange={vi.fn()} />)
    await userEvent.click(screen.getByRole('combobox'))
    expect(screen.getAllByRole('option').map(o => o.getAttribute('aria-label'))).toEqual(['Platform', 'Codex', 'Grok'])
  })
  it('preserves the single-connection picker with no extra dropdown', () => {
    const { container } = render(<ProviderSelect connections={connections.slice(0, 1)} value="Codex" onChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
