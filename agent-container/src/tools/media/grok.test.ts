import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { grokMediaTools } from './grok'
import { mediaToolProviders } from './index'

const generateImages = vi.fn(async () => ['/workspace/media/grok-1.jpg'])
const [grokTool] = grokMediaTools({ generateImages })

afterEach(() => {
  generateImages.mockClear()
})

it('is registered as a provider-prefixed tool', () => {
  expect(grokTool.name).toBe('grok_generate_image')
  expect(mediaToolProviders(['codex', 'grok'])).toEqual(['codex', 'grok'])
})

it('maps tool arguments to the host request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-media-'))
  try {
    const source = path.join(root, 'photo.jpg')
    await writeFile(source, 'foo')
    const result = await grokTool.handler({ prompt: 'as a sketch', aspect_ratio: '1:1', resolution: '2k', referenced_image_paths: [source] }, {})
    expect(generateImages).toHaveBeenCalledWith({ prompt: 'as a sketch', aspectRatio: '1:1', resolution: '2k', images: ['data:image/jpeg;base64,Zm9v'] })
    expect(result.content).toEqual([{ type: 'text', text: 'Generated with Grok:\n/workspace/media/grok-1.jpg' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
