// electron-builder config for the Mac App Store build (`npm run dist:mas`,
// `dist:mas-dev`): the regular config in package.json, minus what the App
// Sandbox or App Review rules out, plus the Store's signing.
//
// A `mas` section in package.json can't do this: electron-builder merges it
// over `mac` (arrays concatenated, objects merged), so it can add to the
// regular build but never take a resource or an Info.plist key away, and the
// Info.plist is written from `mac` alone.
const path = require('path')

const { build: base, version } = require('./package.json')

/** The Store build's bundle id: the Gamut App Store record, `com.superagent.app` being taken there. */
const MAS_APP_ID = 'so.gamut.app'
const TEAM_ID = 'HL9SP7TJ3J'

// Extra resources the Store build leaves out:
// - mediaremote-adapter drives the music player through a private framework;
// - spotlight-bridge (Spotlight search) is not part of the Store build yet.
const LEFT_OUT_RESOURCES = new Set(['mediaremote-adapter', 'spotlight-bridge'])

// Info.plist keys the Store build leaves out. CFBundleAlternateNames lists
// other companies' products (Claude, Codex, ChatGPT) as names for the app.
const { CFBundleAlternateNames: _alternateNames, ...extendInfo } = base.mac.extendInfo

// The Store takes a version of at most three integers (0.5.50, never
// 0.5.50-rc.2), and a build number that grows with every upload of it: CI's
// run number, or the version itself for a local build.
const STORE_VERSION = version.split(/[-+]/)[0]
const STORE_BUILD_NUMBER = process.env.MAS_BUILD_NUMBER || STORE_VERSION

/** A provisioning profile path from the environment; CI decodes one from a secret. */
function profile(name) {
  const value = process.env[name]
  return value ? path.resolve(value) : undefined
}

module.exports = {
  ...base,
  appId: MAS_APP_ID,
  // The Store delivers updates.
  publish: null,
  // A sandboxed app can't register a URL scheme at runtime (the direct build's
  // `setAsDefaultProtocolClient` writes a LaunchServices preference), so the
  // OAuth deep links' scheme is declared in Info.plist.
  protocols: [{ name: 'Gamut', schemes: ['superagent'] }],
  mac: {
    ...base.mac,
    extraResources: base.mac.extraResources.filter((resource) => !LEFT_OUT_RESOURCES.has(resource.to)),
    // Computer use's native binary: it controls other apps, which the sandbox
    // forbids, and the Store build doesn't offer computer use.
    files: [...base.mac.files, '!node_modules/@skillful-agents/agent-computer/bin/ac-core-darwin-*'],
    bundleShortVersion: STORE_VERSION,
    bundleVersion: STORE_BUILD_NUMBER,
    extendInfo: {
      ...extendInfo,
      // Signing reads the team from here before the certificate's name, which
      // for an Apple Development certificate is the person's id, not the team's.
      ElectronTeamID: TEAM_ID,
      // App Review wants the reason, not Electron's generic default.
      NSMicrophoneUsageDescription: 'Gamut uses the microphone for voice mode, so you can talk with your agents.',
    },
    // The Store signs and checks what it distributes.
    notarize: false,
  },
  mas: {
    type: 'distribution',
    hardenedRuntime: false,
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    provisioningProfile: profile('MAS_PROVISIONING_PROFILE'),
  },
  masDev: {
    type: 'development',
    hardenedRuntime: false,
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    provisioningProfile: profile('MAS_DEV_PROVISIONING_PROFILE'),
  },
}
