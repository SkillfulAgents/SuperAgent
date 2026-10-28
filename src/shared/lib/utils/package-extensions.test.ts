import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { AGENT_PACKAGE_EXTENSION, SKILL_PACKAGE_EXTENSION, isImportPackagePath } from './package-extensions'

describe('isImportPackagePath', () => {
  it('matches .agent and .skill paths case-insensitively', () => {
    expect(isImportPackagePath('/tmp/researcher-template.agent')).toBe(true)
    expect(isImportPackagePath('C:\\Downloads\\pdf-tools.SKILL')).toBe(true)
  })

  it('rejects other extensions, including zips and near-misses', () => {
    expect(isImportPackagePath('/tmp/researcher-template.zip')).toBe(false)
    expect(isImportPackagePath('/tmp/notes.agent.txt')).toBe(false)
    expect(isImportPackagePath('/tmp/agent')).toBe(false)
    expect(isImportPackagePath('/tmp/photo.png')).toBe(false)
  })
})

describe('electron-builder fileAssociations sync', () => {
  // package.json can't import these constants, so its `fileAssociations` block
  // is a hand-maintained copy — this is the mechanical check that the OS keeps
  // registering exactly the extensions the import pipeline routes on.
  it('registers exactly the branded package extensions with the OS', () => {
    const packageJsonSchema = z.object({
      build: z.object({
        fileAssociations: z.array(z.object({ ext: z.string() })),
      }),
    })
    const raw = fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf-8')
    const pkg = packageJsonSchema.parse(JSON.parse(raw))

    const registered = pkg.build.fileAssociations.map((a) => `.${a.ext}`).sort()
    expect(registered).toEqual([AGENT_PACKAGE_EXTENSION, SKILL_PACKAGE_EXTENSION].sort())
    for (const ext of registered) {
      expect(isImportPackagePath(`/tmp/example${ext}`)).toBe(true)
    }
  })
})
