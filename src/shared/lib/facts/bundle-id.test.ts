import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { DIRECT_MAC_BUNDLE_ID, MAS_BUNDLE_ID, macBundleId } from './bundle-id'

const require = createRequire(import.meta.url)

describe('macBundleId', () => {
  it('is the Store record’s id for the Mac App Store build, and the regular one otherwise', () => {
    expect(macBundleId({ shell: 'electron', os: 'darwin', distribution: 'mac-app-store' })).toBe(MAS_BUNDLE_ID)
    expect(macBundleId({ shell: 'electron', os: 'darwin', distribution: 'direct' })).toBe(DIRECT_MAC_BUNDLE_ID)
  })

  it('matches the ids electron-builder signs each build with', () => {
    expect(require('../../../../package.json').build.appId).toBe(DIRECT_MAC_BUNDLE_ID)
    expect(require('../../../../electron-builder.mas.cjs').appId).toBe(MAS_BUNDLE_ID)
  })
})
