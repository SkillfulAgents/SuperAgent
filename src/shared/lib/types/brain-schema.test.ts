import { describe, expect, it } from 'vitest'
import { BRAIN_INDEX_FILENAME } from '@shared/lib/config/data-dir'
import { pageDescription, pageReadSchema, resolveBrainPageFilename } from './brain-schema'

describe('resolveBrainPageFilename', () => {
  it('maps INDEX aliases to INDEX.md', () => {
    expect(resolveBrainPageFilename('INDEX')).toBe(BRAIN_INDEX_FILENAME)
    expect(resolveBrainPageFilename('INDEX.md')).toBe(BRAIN_INDEX_FILENAME)
    expect(resolveBrainPageFilename('index.md')).toBe(BRAIN_INDEX_FILENAME)
    expect(resolveBrainPageFilename('  INDEX.md  ')).toBe(BRAIN_INDEX_FILENAME)
  })

  it('maps a kebab slug to a markdown file', () => {
    expect(resolveBrainPageFilename('pricing-decisions')).toBe('pricing-decisions.md')
    expect(resolveBrainPageFilename('pricing-decisions.md')).toBe('pricing-decisions.md')
  })

  it('rejects traversal, case variants, and unstructured names', () => {
    expect(resolveBrainPageFilename('../etc/passwd')).toBeNull()
    expect(resolveBrainPageFilename('foo/bar')).toBeNull()
    expect(resolveBrainPageFilename('Index.md/../x')).toBeNull()
    expect(resolveBrainPageFilename('Bad Name')).toBeNull()
    expect(resolveBrainPageFilename('INDEX.md/../x')).toBeNull()
  })
})

describe('pageDescription', () => {
  it('uses the first non-empty line and strips a heading mark', () => {
    expect(pageDescription('# Team Brain\n\nCurator-owned catalog.\n')).toBe('Team Brain')
    expect(pageDescription('\n\nbilling is monthly\n')).toBe('billing is monthly')
    expect(pageDescription('')).toBe('')
  })
})

describe('pageReadSchema', () => {
  it('accepts INDEX.md and a slug', () => {
    expect(pageReadSchema.parse({ name: 'INDEX.md' }).name).toBe('INDEX.md')
    expect(pageReadSchema.parse({ name: 'billing-policy' }).name).toBe('billing-policy')
  })

  it('rejects an invalid name', () => {
    expect(() => pageReadSchema.parse({ name: '../secret' })).toThrow()
  })
})
