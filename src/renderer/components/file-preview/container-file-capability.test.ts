import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every format the product renders must have a matching read capability in the
 * agent container. Native = SDK Read handles text/images directly; otherwise
 * the apt package(s) that provide the binary must appear in the Dockerfile.
 */
const CONTAINER_CAPABILITY: Record<string, string[]> = {
  audio: ['ffmpeg'],
  csv: [],
  html: [],
  image: [],
  markdown: [],
  pdf: ['poppler-utils'],
  text: [],
  video: ['ffmpeg'],
}

const here = dirname(fileURLToPath(import.meta.url))
const renderersDir = join(here, 'renderers')
const dockerfilePath = resolve(here, '../../../../agent-container/Dockerfile')

function declaredFormats(): string[] {
  return readdirSync(renderersDir)
    .filter(name => name.endsWith('-renderer.tsx'))
    .filter(name => name !== 'file-renderer.tsx' && name !== 'unsupported-renderer.tsx')
    .map(name => name.replace(/-renderer\.tsx$/, ''))
    .sort()
}

describe('container file-format capability', () => {
  const formats = declaredFormats()
  const dockerfile = readFileSync(dockerfilePath, 'utf8')

  it('declares a container capability for every renderer format', () => {
    for (const format of formats) {
      expect(
        CONTAINER_CAPABILITY,
        `New renderer "${format}" must declare its container read capability in CONTAINER_CAPABILITY`,
      ).toHaveProperty(format)
    }
  })

  it('has no stale capability entries without a renderer', () => {
    const declared = new Set(formats)
    for (const format of Object.keys(CONTAINER_CAPABILITY)) {
      expect(
        declared.has(format),
        `Stale CONTAINER_CAPABILITY key "${format}" has no matching *-renderer.tsx`,
      ).toBe(true)
    }
  })

  it('bakes every required apt package into the agent-container Dockerfile', () => {
    const missing: string[] = []
    for (const format of formats) {
      for (const pkg of CONTAINER_CAPABILITY[format] ?? []) {
        if (!new RegExp(`\\b${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(dockerfile)) {
          missing.push(`${format} → ${pkg}`)
        }
      }
    }
    expect(missing, `Missing apt packages in agent-container/Dockerfile: ${missing.join(', ')}`).toEqual(
      [],
    )
  })
})
