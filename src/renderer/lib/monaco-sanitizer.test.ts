import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizePath, resolveConfig } from 'vite'
import { build } from 'esbuild'
import webConfig from '../../../vite.config'
import electronConfig from '../../../electron.vite.config'

describe('Monaco sanitizer resolution', () => {
  it.each([
    ['web dev', webConfig.resolve, 'serve'],
    ['web production', webConfig.resolve, 'build'],
    ['Electron dev', electronConfig.renderer?.resolve, 'serve'],
    ['Electron production', electronConfig.renderer?.resolve, 'build'],
  ] as const)('uses the patched package in the %s renderer', async (_name, resolve, command) => {
    const config = await resolveConfig({
      configFile: false,
      envFile: false,
      resolve,
    }, command)
    const resolveImport = config.createResolver()
    const importer = path.resolve('node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js')

    // Monaco imports a vendored file; an npm override alone cannot replace it.
    expect(await resolveImport('./dompurify/dompurify.js', importer)).toBe(
      normalizePath(path.resolve('node_modules/dompurify/dist/purify.es.mjs')),
    )
  })

  it.each([
    ['web', webConfig.optimizeDeps],
    ['Electron', electronConfig.renderer?.optimizeDeps],
  ])('replaces the vendored sanitizer inside the %s dependency optimizer', async (_name, optimizer) => {
    // Exercise the same bundler and plugin that Vite uses for dependencies;
    // resolve.alias alone does not cover relative JS imports during this step.
    // This fixture stays in memory and never builds the app or writes dist/.
    const result = await build({
      entryPoints: ['node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js'],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      plugins: optimizer?.esbuildOptions?.plugins,
      loader: { '.css': 'empty', '.ttf': 'dataurl' },
    })
    const inputs = Object.keys(result.metafile!.inputs)
    expect(inputs).toContain('node_modules/dompurify/dist/purify.es.mjs')
    expect(inputs).not.toContain('node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js')
  })
})
