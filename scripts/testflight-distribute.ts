// Waits for an uploaded build to finish processing in App Store Connect, then
// adds it to TestFlight groups, submitting it for Beta App Review when one is
// external. For a full release, it also leaves an App Store version ready to
// submit with the build. The release's Store job runs it after altool's upload.
//
// Usage: tsx scripts/testflight-distribute.ts --app <Apple ID> --build <CFBundleVersion>
//          --groups "Team,Beta" [--platform MAC_OS] [--what-to-test "…"] [--timeout-minutes 60]
//          [--app-store-version 0.6.0 [--whats-new "…"]]
// Env: APPLE_API_KEY_BASE64 (the .p8, base64), APPLE_API_KEY_ID, APPLE_API_ISSUER
import { parseArgs } from 'node:util'
import { prepareAppStoreVersion } from './lib/app-store-version'
import { appStoreConnectToken, createClient, distributeBuild, waitForBuild } from './lib/testflight'

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    build: { type: 'string' },
    groups: { type: 'string' },
    platform: { type: 'string', default: 'MAC_OS' },
    'what-to-test': { type: 'string' },
    'timeout-minutes': { type: 'string', default: '60' },
    'app-store-version': { type: 'string' },
    'whats-new': { type: 'string' },
  },
})
const { APPLE_API_KEY_BASE64, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env
const groups = (values.groups ?? '').split(',').map((g) => g.trim()).filter(Boolean)
if (!values.app || !values.build || groups.length === 0 || !APPLE_API_KEY_BASE64 || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
  console.error('Usage: tsx scripts/testflight-distribute.ts --app <id> --build <number> --groups <names>, with APPLE_API_KEY_BASE64, APPLE_API_KEY_ID and APPLE_API_ISSUER set')
  process.exit(2)
}
if (values.platform !== 'MAC_OS' && values.platform !== 'IOS') {
  console.error(`--platform is MAC_OS or IOS, not ${values.platform}`)
  process.exit(2)
}
const storeVersion = values['app-store-version'] || undefined
if (storeVersion && !/^\d+(\.\d+){0,2}$/.test(storeVersion)) {
  console.error(`--app-store-version is a release's version of at most three numbers, not ${storeVersion}`)
  process.exit(2)
}

const appId = values.app
const buildNumber = values.build
const platform = values.platform
const key = { keyId: APPLE_API_KEY_ID, issuerId: APPLE_API_ISSUER, privateKey: Buffer.from(APPLE_API_KEY_BASE64, 'base64').toString('utf8') }
const client = createClient(() => appStoreConnectToken(key))

async function main(): Promise<void> {
  const buildId = await waitForBuild(client, {
    appId,
    buildNumber,
    platform,
    timeoutMs: Number(values['timeout-minutes']) * 60_000,
    intervalMs: 30_000,
  })
  await distributeBuild(client, { appId, buildId, groups, whatToTest: values['what-to-test'] })
  if (storeVersion) {
    await prepareAppStoreVersion(client, { appId, platform, versionString: storeVersion, buildId, whatsNew: values['whats-new'] || undefined })
  }
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`)
  process.exit(1)
})
