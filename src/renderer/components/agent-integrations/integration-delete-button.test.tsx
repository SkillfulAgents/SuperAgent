// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntegrationDeleteButton } from './integration-delete-button'
import { makeChatIntegration as makeIntegration } from './test-factories'

const deleteAsync = vi.fn().mockResolvedValue(undefined)
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useDeleteAgentIntegration: () => ({ mutateAsync: deleteAsync, isPending: false }),
}))

describe('IntegrationDeleteButton', () => {
  beforeEach(() => { deleteAsync.mockClear() })

  it('deletes then calls onDeleted', async () => {
    const user = userEvent.setup()
    const onDeleted = vi.fn()
    render(<IntegrationDeleteButton integration={makeIntegration()} onDeleted={onDeleted} />)
    await user.click(screen.getByRole('button', { name: 'Delete add-on' }))
    await user.click(screen.getByRole('button', { name: 'Delete Add-on' }))
    expect(deleteAsync).toHaveBeenCalledWith({ id: 'int-1', agentSlug: 'a' })
    expect(onDeleted).toHaveBeenCalled()
  })
})
