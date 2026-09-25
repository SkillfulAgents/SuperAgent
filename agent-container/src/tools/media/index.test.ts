import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MEDIA_TOOLS, mediaToolProviders, saveGeneratedMedia } from './index'
import { generateSystemPrompt } from '../../claude-code'

afterEach(() => {
  delete MEDIA_TOOLS.fake
})

describe('mediaToolProviders', () => {
  it('keeps only host providers this container has tools for', () => {
    expect(mediaToolProviders(['fake', 'unknown'])).toEqual([])
    MEDIA_TOOLS.fake = () => []
    expect(mediaToolProviders(['fake', 'unknown'])).toEqual(['fake'])
    expect(mediaToolProviders(['toString'])).toEqual([])
    expect(mediaToolProviders(undefined)).toEqual([])
  })
})

describe('saveGeneratedMedia', () => {
  it('writes each image under the media directory and returns the paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'media-'))
    try {
      const directory = path.join(root, 'media')
      const files = await saveGeneratedMedia('codex', [
        { mimeType: 'image/png', base64: Buffer.from('first').toString('base64') },
        { mimeType: 'image/jpeg', base64: Buffer.from('second').toString('base64') },
      ], directory)
      expect(files).toHaveLength(2)
      expect(files.every(file => path.dirname(file) === directory && path.basename(file).startsWith('codex-'))).toBe(true)
      expect(path.extname(files[0])).toBe('.png')
      expect(path.extname(files[1])).toBe('.jpg')
      expect(await readFile(files[1], 'utf8')).toBe('second')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('subscription media prompt', () => {
  it('renders only when a provider has tools', () => {
    expect(generateSystemPrompt()).not.toContain('## Subscription media generation')
    const out = generateSystemPrompt(undefined, undefined, undefined, undefined, undefined, undefined, undefined, ['codex', 'grok'])
    expect(out).toContain('## Subscription media generation')
    expect(out).toContain('connected subscriptions (codex, grok)')
    expect(out).not.toMatch(/<%|%>/)
  })
})
