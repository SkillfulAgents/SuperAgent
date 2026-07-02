// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntegrationDeleteButton } from './integration-delete-button'
import { makeChatIntegration as makeIntegration } from './test-factories'

const deleteAsync = vi.fn().mockResolvedValue(undefined)
vi.mock('@renderer/hooks/use-chat-integrations', () => ({
  useDeleteChatIntegration: () => ({ mutateAsync: deleteAsync, isPending: false }),
}))

describe('IntegrationDeleteButton', () => {
  beforeEach(() => { deleteAsync.mockClear() })

  it('deletes then calls onDeleted', async () => {
    const user = userEvent.setup()
    const onDeleted = vi.fn()
    render(<IntegrationDeleteButton integration={makeIntegration()} onDeleted={onDeleted} />)
    await user.click(screen.getByRole('button', { name: 'Delete integration' }))
    await user.click(screen.getByRole('button', { name: 'Delete Integration' }))
    expect(deleteAsync).toHaveBeenCalledWith({ id: 'int-1', agentSlug: 'a' })
    expect(onDeleted).toHaveBeenCalled()
  })
})
