import type { ClientFacts } from './facts-schema'

/**
 * The bundle id each macOS desktop build ships under: electron-builder's
 * `appId` in package.json, and in `electron-builder.mas.cjs` for the Mac App
 * Store build, which ships under the Gamut App Store record because
 * `com.superagent.app` is taken on the Store. `bundle-id.test.ts` keeps the two
 * configs to these.
 */
export const DIRECT_MAC_BUNDLE_ID = 'com.superagent.app'
export const MAS_BUNDLE_ID = 'so.gamut.app'

/** The bundle id of this window's desktop app on macOS, which System Settings knows it by. */
export function macBundleId(client: ClientFacts): string {
  return client.distribution === 'mac-app-store' ? MAS_BUNDLE_ID : DIRECT_MAC_BUNDLE_ID
}
