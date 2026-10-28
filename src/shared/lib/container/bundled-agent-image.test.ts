import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findBundledAgentImage } from './bundled-agent-image'

const IMAGE = 'ghcr.io/acme/agent:1.0.0'
const HOST_ARCH = process.arch === 'x64' ? 'amd64' : 'arm64'

describe('findBundledAgentImage', () => {
  let resources: string
  const originalResourcesPath = process.resourcesPath

  const bundle = (description: Record<string, unknown>, archiveBytes = 4096) => {
    const dir = path.join(resources, 'agent-image')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent-image.tar'), Buffer.alloc(archiveBytes))
    fs.writeFileSync(path.join(dir, 'agent-image.json'), JSON.stringify(description))
  }
  const description = (overrides: Record<string, unknown> = {}) => ({
    image: IMAGE,
    architecture: HOST_ARCH,
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    archiveBytes: 4096,
    ...overrides,
  })

  beforeEach(() => {
    resources = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-agent-image-'))
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true })
    fs.rmSync(resources, { recursive: true, force: true })
  })

  it('finds the archive bundled for the image on this machine', () => {
    bundle(description())

    expect(findBundledAgentImage(IMAGE)).toEqual({
      path: path.join(resources, 'agent-image', 'agent-image.tar'),
      description: description(),
    })
  })

  it('ignores it for any other image, such as a custom one in settings', () => {
    bundle(description())

    expect(findBundledAgentImage('ghcr.io/acme/agent:1.0.1')).toBeNull()
    expect(findBundledAgentImage('registry.example.com/custom:latest')).toBeNull()
  })

  it('ignores an archive for another architecture', () => {
    bundle(description({ architecture: HOST_ARCH === 'arm64' ? 'amd64' : 'arm64' }))

    expect(findBundledAgentImage(IMAGE)).toBeNull()
  })

  it('ignores an archive whose size is not the one recorded (a truncated copy)', () => {
    bundle(description(), 1024)

    expect(findBundledAgentImage(IMAGE)).toBeNull()
  })

  it('ignores a description that does not parse', () => {
    bundle({ image: IMAGE, architecture: HOST_ARCH })

    expect(findBundledAgentImage(IMAGE)).toBeNull()
  })

  it('finds nothing when the app ships no archive (Windows, dev, an image published too late)', () => {
    expect(findBundledAgentImage(IMAGE)).toBeNull()
  })
})
