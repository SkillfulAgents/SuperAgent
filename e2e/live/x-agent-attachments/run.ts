#!/usr/bin/env npx tsx

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attachmentProbeAgentsSchema,
  attachmentProbeProofSchema,
  attachmentProbeRunMetadataSchema,
  probeSourceSettingsSchema,
  seededProbeSettingsSchema,
} from './probe-schema'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, '').split('=')
  return [key, value.length > 0 ? value.join('=') : true]
}))
const source = typeof args.source === 'string'
  ? args.source
  : process.env.X_AGENT_ATTACHMENTS_SOURCE_DIR ?? path.join(os.homedir(), 'Downloads', 'superagent-sdk257')
const tagSuffix = randomUUID()
const image = typeof args.image === 'string'
  ? args.image
  : `superagent-container:x-agent-attachments-${tagSuffix}`
const runDir = path.join(os.tmpdir(), `x-agent-attachments-${Date.now()}`)
const target = mkdtempSync(path.join(os.tmpdir(), 'x-agent-attachments-data-'))
const marker = '.x-agent-attachments-probe'
const containerBasePort = 5600

function log(message: string) {
  console.log(`[x-agent-attachments] ${message}`)
}

function seed() {
  const settingsPath = path.join(source, 'settings.json')
  if (!existsSync(settingsPath)) throw new Error(`No settings.json in ${source}`)
  let parsedSettings: unknown
  try {
    parsedSettings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid JSON in ${settingsPath}`, { cause: error })
  }
  const settings = probeSourceSettingsSchema.parse(parsedSettings)
  const seeded = seededProbeSettingsSchema.parse({
    apiKeys: settings.apiKeys,
    ...(settings.llmProvider ? { llmProvider: settings.llmProvider } : {}),
    ...(settings.models ? { models: settings.models } : {}),
    ...(settings.modelCatalog ? { modelCatalog: settings.modelCatalog } : {}),
    ...(settings.agentLimits ? { agentLimits: settings.agentLimits } : {}),
    container: {
      containerRunner: 'docker',
      agentImage: image,
      ...(settings.container?.resourceLimits ? { resourceLimits: settings.container.resourceLimits } : {}),
    },
    app: { setupCompleted: true },
    shareAnalytics: false,
    shareErrorReports: false,
  })
  writeFileSync(path.join(target, marker), 'x-agent attachment probe scratch dir\n', { mode: 0o600 })
  writeFileSync(path.join(target, 'settings.json'), JSON.stringify(seeded, null, 2), { mode: 0o600 })
  log(`seeded isolated data dir ${target} from ${source}`)
}

function removeSeededDataDir() {
  if (!existsSync(path.join(target, marker))) return
  try {
    rmSync(target, { recursive: true, force: true })
    log(`removed credential-bearing data dir ${target}`)
  } catch (error) {
    log(`could not remove ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function buildImage() {
  if (args['skip-build']) {
    log(`using existing image ${image}`)
    return
  }
  log(`building final checkout as ${image}`)
  const result = spawnSync('docker', ['build', '-t', image, 'agent-container'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`docker build failed with status ${result.status}`)
}

function writeRunMetadata() {
  const metadata = attachmentProbeRunMetadataSchema.parse({
    imageTag: image,
    imageId: execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim(),
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    gitStatus: execFileSync('git', ['status', '--short'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
    builtFromCheckout: !args['skip-build'],
  })
  writeFileSync(path.join(runDir, 'run-metadata.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 })
}

async function freePort(): Promise<number> {
  for (let port = 3460; port < 3500; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (available) return port
  }
  throw new Error('No free port in 3460-3499')
}

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs: number, intervalMs = 1_000) {
  const startedAt = Date.now()
  for (;;) {
    try {
      if (await probe()) return
    } catch {
      // Retry until the deadline so startup races do not fail the probe.
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

interface RunningApp {
  child: ChildProcess
  base: string
  logFile: string
}

async function startApp(port: number): Promise<RunningApp> {
  const logFile = path.join(runDir, 'host.log')
  const output = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SUPERAGENT_DATA_DIR: target,
      PORT: String(port),
      NODE_ENV: 'development',
      SUPERAGENT_BASE_PORT: String(containerBasePort),
      SUPERAGENT_TEST_UPDATES: '',
      E2E_MOCK: '',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(output)
  child.stderr?.pipe(output)
  let exited: string | null = null
  child.on('exit', (code, signal) => { exited = `code=${code} signal=${signal}` })
  const base = `http://127.0.0.1:${port}`
  try {
    await waitFor('host API', async () => {
      if (exited) throw new Error(`host exited (${exited}); see ${logFile}`)
      return (await fetch(`${base}/api/settings`)).ok
    }, 180_000)
  } catch (error) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    output.end()
    throw error
  }
  log(`host up at ${base}; logs: ${logFile}`)
  return { child, base, logFile }
}

async function stopApp(app: RunningApp) {
  if (app.child.pid) {
    try {
      process.kill(-app.child.pid, 'SIGTERM')
    } catch {
      app.child.kill('SIGTERM')
    }
  }
  try {
    await waitFor('host shutdown', async () => {
      try {
        await fetch(`${app.base}/api/agents`)
        return false
      } catch {
        return true
      }
    }, 60_000)
  } catch (error) {
    if (app.child.pid) {
      try { process.kill(-app.child.pid, 'SIGKILL') } catch { app.child.kill('SIGKILL') }
    }
    throw error
  }
}

function captureContainer(name: string) {
  const containerLog = path.join(runDir, `${name}.container.log`)
  try {
    const logs = execFileSync('docker', ['logs', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(containerLog, logs)
  } catch (error) {
    writeFileSync(containerLog, `Could not capture logs: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  log(`container evidence: ${containerLog}`)
}

function removeContainer(name: string): boolean {
  const exists = spawnSync('docker', ['container', 'inspect', name], { stdio: 'ignore' }).status === 0
  if (!exists) return true
  return spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }).status === 0
}

function filesWithExtension(directory: string, extension: string): string[] {
  const found: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) walk(candidate)
      else if (candidate.endsWith(extension)) found.push(candidate)
    }
  }
  if (existsSync(directory)) walk(directory)
  return found
}

function convertVideo(webm: string): string {
  const mp4 = path.join(runDir, 'x-agent-attachments-demo.mp4')
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', webm,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart', '-an', mp4,
  ], { stdio: 'inherit' })
  return mp4
}

async function main() {
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  log(`run evidence dir ${runDir}`)
  let app: RunningApp | null = null
  let exitCode = 1
  const outputDir = path.join(runDir, 'test-results')
  const handleSignal = (signal: NodeJS.Signals) => {
    log(`received ${signal}; removing probe credentials`)
    if (app?.child.pid) {
      try { process.kill(-app.child.pid, 'SIGKILL') } catch { app.child.kill('SIGKILL') }
    }
    const agentFiles = filesWithExtension(outputDir, 'agents.json')
    if (agentFiles.length === 1) {
      try {
        const agents = attachmentProbeAgentsSchema.parse(JSON.parse(readFileSync(agentFiles[0], 'utf8')))
        for (const slug of [agents.callerSlug, agents.calleeSlug]) removeContainer(`superagent-${slug}`)
      } catch {
        // The normal finally block will retry if the child exits cleanly.
      }
    }
    if (!args['keep-data']) removeSeededDataDir()
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)
  try {
    buildImage()
    writeRunMetadata()
    seed()
    app = await startApp(await freePort())
    const result = spawnSync('npx', ['playwright', 'test', '--config', 'playwright.live-x-agent-attachments.config.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        E2E_BASE_URL: app.base,
        PLAYWRIGHT_OUTPUT_DIR: outputDir,
      },
      stdio: 'inherit',
    })
    exitCode = result.status ?? 1
    if (exitCode !== 0) throw new Error(`Playwright failed with status ${exitCode}`)

    const proofFiles = filesWithExtension(outputDir, 'proof.json')
    if (proofFiles.length !== 1) throw new Error(`Expected one proof.json, found ${proofFiles.length}`)
    const proof = attachmentProbeProofSchema.parse(JSON.parse(readFileSync(proofFiles[0], 'utf8')))
    const hashes = new Set([
      proof.expectedSha256,
      proof.callerUploadSha256,
      proof.calleeAttachmentSha256,
      proof.calleeDeliverySha256,
      proof.callerDownloadSha256,
    ])
    if (hashes.size !== 1) throw new Error('Roundtrip hashes differ')
    log(`PASS: ${proof.expectedBytes} bytes matched SHA-256 ${proof.expectedSha256} at all four boundaries`)
    log(`sessions: ${proof.callerSlug}/${proof.callerSessionId} -> ${proof.calleeSlug}/${proof.calleeSessionId}`)

    const videos = filesWithExtension(outputDir, '.webm')
    if (videos.length !== 1) throw new Error(`Expected one Playwright video, found ${videos.length}`)
    const mp4 = convertVideo(videos[0])
    const duration = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4,
    ], { encoding: 'utf8' }).trim()
    log(`demo video: ${mp4} (${Number(duration).toFixed(1)}s)`)
  } catch (error) {
    console.error(`[x-agent-attachments] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    exitCode = 1
  } finally {
    process.off('SIGINT', handleSignal)
    process.off('SIGTERM', handleSignal)
    const ownedContainers: string[] = []
    const agentFiles = filesWithExtension(outputDir, 'agents.json')
    if (agentFiles.length === 1) {
      try {
        const agents = attachmentProbeAgentsSchema.parse(JSON.parse(readFileSync(agentFiles[0], 'utf8')))
        for (const slug of [agents.callerSlug, agents.calleeSlug]) {
          const name = `superagent-${slug}`
          ownedContainers.push(name)
          captureContainer(name)
        }
      } catch (error) {
        log(`could not identify probe-owned containers: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (app) await stopApp(app).catch((error) => {
      log(`host stop failed: ${String(error)}`)
      exitCode = 1
    })
    for (const name of ownedContainers) {
      if (!removeContainer(name)) {
        log(`could not remove credential-bearing container ${name}`)
        exitCode = 1
      }
    }
    if (args['keep-data']) log(`kept ${target}; it contains credentials and must be deleted manually`)
    else removeSeededDataDir()
  }
  process.exit(exitCode)
}

void main()
