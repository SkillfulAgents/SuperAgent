import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { codexMediaTools } from './codex'

let root: string
const generateImages = vi.fn(async () => ['/workspace/media/codex-1.png'])
const [codexTool] = codexMediaTools({ generateImages, startVideo: vi.fn(), waitForVideo: vi.fn() })

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codex-media-'))
})
afterEach(async () => {
  generateImages.mockClear()
  await rm(root, { recursive: true, force: true })
})

it('exposes a provider-prefixed tool', () => {
  expect(codexTool.name).toBe('codex_generate_image')
})

it('sends referenced images as data URLs and returns saved paths', async () => {
  const source = path.join(root, 'source.png')
  await writeFile(source, 'foo')
  const result = await codexTool.handler({ prompt: 'make it blue', transparent_background: true, referenced_image_paths: [source] }, {})
  expect(generateImages).toHaveBeenCalledWith({ prompt: 'make it blue', transparentBackground: true, images: ['data:image/png;base64,Zm9v'] })
  expect(result.isError).toBeFalsy()
  expect(result.content).toEqual([{ type: 'text', text: 'Generated with Codex:\n/workspace/media/codex-1.png' }])
})

it('reports unsupported reference files without calling the host', async () => {
  const source = path.join(root, 'notes.txt')
  await writeFile(source, 'text')
  const result = await codexTool.handler({ prompt: 'edit', referenced_image_paths: [source] }, {})
  expect(result.isError).toBe(true)
  expect(generateImages).not.toHaveBeenCalled()
})
