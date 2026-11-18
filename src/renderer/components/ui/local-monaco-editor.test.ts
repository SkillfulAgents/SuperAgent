// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

vi.mock('monaco-editor', () => ({ editor: { create: vi.fn() } }))
vi.mock('monaco-editor/esm/vs/editor/editor.worker.js?worker', () => ({
  default: class { readonly kind = 'editor' },
}))
vi.mock('monaco-editor/esm/vs/language/css/css.worker.js?worker', () => ({
  default: class { readonly kind = 'css' },
}))
vi.mock('monaco-editor/esm/vs/language/html/html.worker.js?worker', () => ({
  default: class { readonly kind = 'html' },
}))
vi.mock('monaco-editor/esm/vs/language/json/json.worker.js?worker', () => ({
  default: class { readonly kind = 'json' },
}))
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker.js?worker', () => ({
  default: class { readonly kind = 'typescript' },
}))

describe('local Monaco loading', () => {
  it('initializes the real loader without injecting a CDN script', async () => {
    const append = vi.spyOn(document.body, 'appendChild')
    try {
      await import('./local-monaco-editor')
      expect(await loader.init()).toBe(monaco)
      expect(append).not.toHaveBeenCalled()
    } finally {
      append.mockRestore()
    }
  })

  it.each([
    ['json', 'json'],
    ['css', 'css'],
    ['scss', 'css'],
    ['less', 'css'],
    ['html', 'html'],
    ['handlebars', 'html'],
    ['razor', 'html'],
    ['typescript', 'typescript'],
    ['javascript', 'typescript'],
    ['markdown', 'editor'],
    ['python', 'editor'],
    ['plaintext', 'editor'],
  ])('provides a local worker for %s files', async (language, kind) => {
    await import('./local-monaco-editor')
    expect(self.MonacoEnvironment?.getWorker?.('', language)).toMatchObject({ kind })
  })
})
