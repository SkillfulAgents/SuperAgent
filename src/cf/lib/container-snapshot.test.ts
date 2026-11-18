import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IMAGE_ENV, containerSnapshotFrom, snapshotStartCommand } from './container-snapshot'

/** The ENV lines of the Dockerfile's last stage and of the stages it builds on. */
function dockerfileEnv(): Record<string, string> {
  const lines = fs.readFileSync(path.resolve(__dirname, '../../../agent-container/Dockerfile'), 'utf8').split('\n')
  const stages: Array<{ name: string; parent: string; env: Record<string, string> }> = []
  for (const line of lines) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line)
    if (from) stages.push({ name: from[2] ?? '', parent: from[1], env: {} })
    const env = /^ENV\s+([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (env && stages.length > 0) stages[stages.length - 1].env[env[1]] = env[2].trim().replace(/^"(.*)"$/, '$1')
  }
  const chain: Record<string, string>[] = []
  for (let stage = stages[stages.length - 1]; stage; stage = stages.find((other) => other.name === stage.parent)!) chain.unshift(stage.env)
  return Object.assign({}, ...chain)
}

describe('IMAGE_ENV', () => {
  it("is the agent image's environment, variable for variable", () => {
    const { PATH, ...fromDockerfile } = IMAGE_ENV
    expect(PATH).toContain('/usr/local/bin')
    expect(fromDockerfile).toEqual(dockerfileEnv())
  })
})

describe('containerSnapshotFrom', () => {
  it("reads the snapshot's id, name and size, and nothing else", () => {
    expect(containerSnapshotFrom('{"id":"snap-1","name":"agent-0.6.11","size":2254857830,"note":"built by the warmer"}')).toEqual({ id: 'snap-1', name: 'agent-0.6.11', size: 2254857830 })
  })

  it('is null when the deployment names no snapshot', () => {
    expect(containerSnapshotFrom(undefined)).toBeNull()
    expect(containerSnapshotFrom('  ')).toBeNull()
  })

  it('refuses a value that is not a snapshot handle', () => {
    expect(() => containerSnapshotFrom('{"id":')).toThrow('CONTAINER_SNAPSHOT is not valid JSON')
    expect(() => containerSnapshotFrom('{"id":"snap-1","name":"agent"}')).toThrow('CONTAINER_SNAPSHOT must be a JSON object with an id, a name and a size')
    expect(() => containerSnapshotFrom('"snap-1"')).toThrow('CONTAINER_SNAPSHOT must be a JSON object')
  })
})

describe('snapshotStartCommand', () => {
  it("runs the command inside the image's file system, with its environment and working directory", () => {
    const [shell, flag, script] = snapshotStartCommand(['gamut-start', 'node', '/opt/gamut/cloudflare/cf-workspace-server.mjs'])

    expect([shell, flag]).toEqual(['sh', '-c'])
    expect(script).toContain("exec chroot /img env 'PATH=")
    expect(script).toContain("'NODE_ENV=production'")
    expect(script).toContain(`cd /app && exec '\\''gamut-start'\\'' '\\''node'\\'' '\\''/opt/gamut/cloudflare/cf-workspace-server.mjs'\\''`)
  })
})
