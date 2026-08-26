// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { McpAdvancedClientFields } from './mcp-advanced-client-fields'

const values = { clientName: '', clientId: '', clientSecret: '' }

describe('McpAdvancedClientFields', () => {
  it('namespaces its test ids so both hosts keep their own', () => {
    const { unmount } = render(
      <McpAdvancedClientFields values={values} onChange={vi.fn()} testIdPrefix="mcp-form" />,
    )
    expect(screen.getByTestId('mcp-form-client-name')).toBeTruthy()
    expect(screen.getByTestId('mcp-form-client-id')).toBeTruthy()
    expect(screen.getByTestId('mcp-form-client-secret')).toBeTruthy()
    unmount()

    render(
      <McpAdvancedClientFields values={values} onChange={vi.fn()} testIdPrefix="mcp-request" />,
    )
    expect(screen.getByTestId('mcp-request-client-id')).toBeTruthy()
  })

  it('reports a single edited field without dropping the others', async () => {
    const onChange = vi.fn()
    render(
      <McpAdvancedClientFields
        values={{ clientName: 'keep-me', clientId: '', clientSecret: 'secret' }}
        onChange={onChange}
        testIdPrefix="mcp-form"
      />,
    )
    await userEvent.type(screen.getByTestId('mcp-form-client-id'), 'a')
    expect(onChange).toHaveBeenCalledWith({
      clientName: 'keep-me',
      clientId: 'a',
      clientSecret: 'secret',
    })
  })

  it('opens only when asked', () => {
    const { unmount } = render(
      <McpAdvancedClientFields values={values} onChange={vi.fn()} testIdPrefix="mcp-form" />,
    )
    expect(screen.getByTestId('mcp-form-advanced').hasAttribute('open')).toBe(false)
    unmount()

    render(
      <McpAdvancedClientFields
        values={values}
        onChange={vi.fn()}
        defaultOpen
        testIdPrefix="mcp-form"
      />,
    )
    expect(screen.getByTestId('mcp-form-advanced').hasAttribute('open')).toBe(true)
  })

  it('keeps the client secret masked', () => {
    render(<McpAdvancedClientFields values={values} onChange={vi.fn()} testIdPrefix="mcp-form" />)
    expect(screen.getByTestId('mcp-form-client-secret').getAttribute('type')).toBe('password')
  })

  it('captions each field in the settings form and omits captions in the compact card', () => {
    const { unmount } = render(
      <McpAdvancedClientFields values={values} onChange={vi.fn()} testIdPrefix="mcp-form" />,
    )
    expect(screen.queryByText('Client ID')).toBeTruthy()
    unmount()

    render(
      <McpAdvancedClientFields
        values={values}
        onChange={vi.fn()}
        variant="compact"
        testIdPrefix="mcp-request"
      />,
    )
    // The request card has no room for captions; the placeholders carry the meaning.
    expect(screen.queryByText('Client ID')).toBeNull()
    expect(
      screen.getByTestId('mcp-request-client-id').getAttribute('placeholder'),
    ).toMatch(/client_id/)
  })

  it('disables every field when the host says so', () => {
    render(
      <McpAdvancedClientFields
        values={values}
        onChange={vi.fn()}
        disabled
        testIdPrefix="mcp-request"
      />,
    )
    for (const id of ['client-name', 'client-id', 'client-secret']) {
      expect((screen.getByTestId(`mcp-request-${id}`) as HTMLInputElement).disabled).toBe(true)
    }
  })
})
