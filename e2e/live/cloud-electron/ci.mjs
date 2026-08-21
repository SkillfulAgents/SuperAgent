/**
 * The CI-runnable form of the live app suite.
 *
 * Same 28 checks, same harness, same real desktop app — but with the platform
 * half replaced by `stub-platform.mjs`, so nothing here needs Supabase, a
 * wrangler worker, or a platform checkout. The deployment stays a real auth-mode
 * build of this app; only discovery and grant minting are stubbed.
 *
 *   npm run build:api          # the deployment's server bundle
 *   npx electron-vite build    # the desktop app under test
 *   npx electron-rebuild -f    # better-sqlite3 on the Electron ABI
 *   node e2e/live/cloud-electron/ci.mjs
 *
 * Note the build set. `npm run build:web` is deliberately absent: it is `vite
 * build`, whose outDir is `dist/renderer` — the same directory `electron-vite
 * build` writes the desktop renderer into. Running both leaves whichever ran
 * last, and the app under test would silently become a web build. Only
 * `build:api` (tsup → `dist/web`) is needed, because the deployment is used
 * here purely as an API; its own SPA is never loaded.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { startStubPlatform } from './stub-platform.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DEPLOYMENT_PORT = Number(process.env.CI_DEPLOYMENT_PORT ?? 8901)
const DEPLOYMENT_URL = `http://127.0.0.1:${DEPLOYMENT_PORT}`
const ORG_ID = 'org_11111111-1111-1111-1111-111111111111'
const EMAIL = 'e2e-owner@test.io'
const PLATFORM_TOKEN = 'plat_sa_ci_deadbeefdeadbeefdeadbeefdeadbeef'

const scratch = mkdtempSync(join(tmpdir(), 'cloud-ci-'))
const deploymentData = join(scratch, 'deployment')
const appData = join(scratch, 'app')

const started = []
let exitCode = 1

async function waitForHttp(url, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(url)
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

try {
  const platform = await startStubPlatform({
    deploymentUrl: DEPLOYMENT_URL,
    orgId: ORG_ID,
    email: EMAIL,
    platformToken: PLATFORM_TOKEN,
  })
  started.push({ name: 'stub platform', close: () => platform.close() })
  console.log(`stub platform: ${platform.url}`)

  // Run the deployment under Electron's Node rather than the system one.
  //
  // Not a preference — the alternative does not work. `better-sqlite3` is a
  // native module, and one `node_modules` can hold exactly one build of it: the
  // Electron ABI for the app under test, or the Node ABI for a server started
  // with `process.execPath`. Whichever is missing dies with `ERR_DLOPEN_FAILED`
  // at `initDb`, and the resulting failure is a token exchange that answers 400
  // — indistinguishable from a bad grant, which is a long way from the cause.
  //
  // `ELECTRON_RUN_AS_NODE=1` makes the Electron binary behave as plain Node, so
  // the deployment loads the very same Electron-ABI build the app does. One
  // checkout, one install, no second `npm ci` and no container.
  const deployment = spawn(electronPath, [join(REPO_ROOT, 'dist/web/server.mjs')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Auth mode at RUNTIME is all the API needs; the build-time constant only
      // governs the deployment's own SPA, which nothing here loads.
      AUTH_MODE: 'true',
      PORT: String(DEPLOYMENT_PORT),
      TRUSTED_ORIGINS: DEPLOYMENT_URL,
      BETTER_AUTH_SECRET: 'ci-secret-0123456789abcdef0123456789abcdef',
      SUPERAGENT_DATA_DIR: deploymentData,
      PLATFORM_TOKEN: platform.deploymentPlatformToken,
      AUTH_PROVIDERS_JSON: platform.deploymentAuthProviders,
      E2E_MOCK: 'true',
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const deploymentLog = []
  deployment.stdout.on('data', (chunk) => deploymentLog.push(String(chunk)))
  deployment.stderr.on('data', (chunk) => deploymentLog.push(String(chunk)))
  deployment.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`deployment exited early (${code}):\n${deploymentLog.join('').slice(-3000)}`)
    }
  })
  started.push({
    name: 'deployment',
    close: async () => {
      deployment.kill('SIGKILL')
      await new Promise((resolve) => deployment.once('exit', resolve))
    },
  })

  await waitForHttp(`${DEPLOYMENT_URL}/api/agents`)
  console.log(`deployment:    ${DEPLOYMENT_URL}`)

  // Fail loudly here rather than letting the suite report a confusing cascade:
  // a 404 means the exchange route is missing or the platform provider is not
  // enabled, and neither is something the checks can diagnose.
  const probe = await fetch(`${DEPLOYMENT_URL}/api/auth/token/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=bogus',
  })
  if (probe.status !== 400) {
    throw new Error(
      `token exchange should reject a bogus assertion with 400, got ${probe.status} — ` +
        'the route is missing, or AUTH_PROVIDERS_JSON did not enable the platform provider',
    )
  }

  console.log('\nrunning the app suite against the stubbed platform\n')
  exitCode = await new Promise((resolve) => {
    const suite = spawn(process.execPath, [join(REPO_ROOT, 'e2e/live/cloud-electron/run.mjs')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LIVE_AUTH_ISSUER_URL: platform.url,
        LIVE_PROXY_URL: platform.url,
        LIVE_DEPLOYMENT_URL: DEPLOYMENT_URL,
        LIVE_PLATFORM_TOKEN: PLATFORM_TOKEN,
        LIVE_ORG_ID: ORG_ID,
        LIVE_EMAIL: EMAIL,
        LIVE_APP_DATA_DIR: appData,
        LIVE_NODE3_DATA_DIR: deploymentData,
      },
      stdio: 'inherit',
    })
    suite.on('exit', (code) => resolve(code ?? 1))
  })

  console.log(`\ngrants minted by the stub: ${platform.grantsMinted}`)
} finally {
  for (const service of started.reverse()) {
    await service.close().catch(() => {})
  }
  rmSync(scratch, { recursive: true, force: true })
}

process.exit(exitCode)
