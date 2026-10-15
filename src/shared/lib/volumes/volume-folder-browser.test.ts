import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { VolumeError } from './volume-error'
import { volumeFolderBrowser } from './volume-folder-browser'

const schema = z.object({ accountId: z.string().min(1), folder: z.string().default('') }).strict()
const viewer = { userId: 'alice' }

describe('volumeFolderBrowser', () => {
  it('validates the query before calling the source, passes the viewer, and keeps folder IDs opaque', async () => {
    const result = { folders: [{ id: '/A folder/文', name: '文' }, { id: 'remote-id', name: 'Shared drive' }] }
    const source = vi.fn(async () => result)
    const browse = volumeFolderBrowser(schema, source)
    await expect(browse({ accountId: '' }, viewer)).rejects.toBeInstanceOf(z.ZodError)
    expect(source).not.toHaveBeenCalled()
    await expect(browse({ accountId: 'account' }, viewer)).resolves.toEqual(result)
    expect(source).toHaveBeenCalledWith({ accountId: 'account', folder: '' }, viewer)
  })

  it.each([
    new WorkspaceFileError('not-found'),
    new WorkspaceFileError('not-accessible'),
    new VolumeError('Source is busy', 429, 60),
  ])('preserves authorization, filesystem and retryable errors', async error => {
    const browse = volumeFolderBrowser(schema, async () => { throw error })
    await expect(browse({ accountId: 'account' }, viewer)).rejects.toBe(error)
  })

  it('reports malformed upstream data as unavailable instead of blaming the input or exposing it', async () => {
    const browse = volumeFolderBrowser(schema, async () => ({ folders: [{ id: '', name: 'Invalid response' }] }))
    await expect(browse({ accountId: 'account' }, viewer)).rejects.toMatchObject({ status: 503 })
    const malformed = volumeFolderBrowser(schema, async () => { schema.parse({}); return { folders: [] } })
    await expect(malformed({ accountId: 'account' }, viewer)).rejects.toMatchObject({ status: 503 })
    const failed = volumeFolderBrowser(schema, async () => { throw new Error('private upstream details') })
    await expect(failed({ accountId: 'account' }, viewer)).rejects.toMatchObject({
      status: 503, message: 'The drive source is temporarily unavailable. Please try again.',
    })
  })
})
