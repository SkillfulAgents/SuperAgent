// Bundled into the dedicated test container; every filesystem path is confined
// to this run underneath the one allowed Dropbox mount.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createCipheriv, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import { z } from 'zod'
import { assertPathWithinDir } from '../../../src/shared/lib/utils/path-safety'
import { parseJson, workerRequestSchema, workerReplySchema } from './schema'

export function bytes(size: number, seed: string): Buffer {
  const key = createHash('sha256').update(seed).digest()
  return createCipheriv('aes-256-ctr', key, Buffer.alloc(16)).update(Buffer.alloc(size))
}
const digest = (data: Buffer) => ({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') })

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = parseJson(raw, workerRequestSchema)
  const root = `/mounts/gamut-test/${input.runName}`
  const absolute = (relative: string) => {
    const resolved = path.resolve(root, relative)
    return assertPathWithinDir(root, resolved, 'Outside test run')
  }
  const target = absolute(input.path)
  const content = () => { if (input.text !== undefined) return Buffer.from(input.text); if (!input.data) throw new Error('Missing data'); return bytes(input.data.size, input.data.seed) }
  const destination = () => { if (!input.destination) throw new Error('Missing destination'); return absolute(input.destination) }
  let result: unknown
  switch (input.op) {
    case 'mkdir': await fs.mkdir(target, { recursive: input.recursive ?? false }); break
    case 'write': await fs.writeFile(target, content()); break
    case 'append': await fs.appendFile(target, content()); break
    case 'truncate': await fs.truncate(target, input.length ?? 0); break
    case 'patch': {
      const handle = await fs.open(target, 'r+')
      try { await handle.write(content(), 0, input.data!.size, input.offset ?? 0) } finally { await handle.close() }
      break
    }
    case 'read': {
      const data = await fs.readFile(target)
      result = digest(data.subarray(input.offset ?? 0, input.length === undefined ? undefined : (input.offset ?? 0) + input.length))
      break
    }
    case 'rename': await fs.rename(target, destination()); break
    case 'copy': await fs.copyFile(target, destination()); break
    case 'symlink': await fs.symlink(target, destination()); break
    case 'hardlink': await fs.link(target, destination()); break
    case 'exclusive': await fs.writeFile(target, content(), { flag: 'wx' }); break
    case 'open-delete':
    case 'open-rename': {
      const handle = await fs.open(target, 'r')
      try {
        // Download before unlink: a previously open descriptor retains bytes.
        const before = await handle.readFile()
        if (input.op === 'open-delete') await fs.unlink(target)
        else await fs.rename(target, destination())
        const after = Buffer.alloc(before.length)
        await handle.read(after, 0, after.length, 0)
        result = { before: digest(before), after: digest(after) }
      } finally { await handle.close() }
      break
    }
    case 'unlink': await fs.unlink(target); break
    case 'rmdir': await fs.rmdir(target); break
    case 'stat': { const stat = await fs.stat(target); result = { size: stat.size, directory: stat.isDirectory() }; break }
    case 'list': result = await fs.readdir(target); break
    case 'walk': {
      const files: { path: string; size: number }[] = []
      const walk = async (directory: string) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = assertPathWithinDir(root, path.join(directory, entry.name))
          if (entry.isDirectory()) await walk(file)
          else if (entry.isFile()) files.push({ path: path.relative(root, file), size: (await fs.stat(file)).size })
          else throw new Error(`Unexpected file type: ${entry.name}`)
        }
      }
      await walk(target)
      result = files
      break
    }
    case 'git': {
      await fs.mkdir(target)
      const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: target, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
      await git('init', '-q')
      await git('config', 'user.email', 'integration-test@example.invalid')
      await git('config', 'user.name', 'Gamut integration test')
      await fs.writeFile(path.join(target, 'tracked.txt'), bytes(100, 'git-first'))
      await git('add', '.')
      await git('commit', '-qm', 'first test commit')
      await fs.writeFile(path.join(target, 'tracked.txt'), bytes(200, 'git-second'))
      await git('add', '.')
      await git('commit', '-qm', 'second test commit')
      result = (await git('status', '--porcelain')).stdout
      break
    }
    case 'rc': {
      result = await new Promise((resolve, reject) => {
        const req = http.request({ socketPath: `/tmp/rclone-${input.attachmentId}.sock`, path: `/${input.command}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
          let body = ''
          res.on('data', chunk => { body += chunk })
          res.on('end', () => {
            if (res.statusCode !== 200) { reject(new Error(`rclone ${input.command}: HTTP ${res.statusCode}: ${body}`)); return }
            try { resolve(parseJson(body, z.json())) } catch (error) { reject(error) }
          })
          res.on('error', reject)
        })
        req.on('error', reject)
        req.end(JSON.stringify(input.command === 'vfs/queue' ? {} : {
          dir: `${input.runName}/${input.path}`.replace(/\/$/, ''),
          ...(input.command === 'vfs/refresh' ? { recursive: String(input.recursive ?? false) } : {}),
        }))
      })
      break
    }
    case 'webdav': {
      const base = `${process.env.SUPERAGENT_HOST_API_URL}/volumes/${input.attachmentId}`
      const url = (relative: string) => `${base}/${[input.runName, ...relative.split('/')].map(encodeURIComponent).join('/')}`
      const headers = new Headers(input.headers)
      headers.set('Authorization', `Bearer ${process.env.PROXY_TOKEN}`)
      if (input.destination) headers.set('Destination', url(input.destination))
      const response = await fetch(url(input.path), { method: input.method, headers, ...(input.data || input.text !== undefined ? { body: new Uint8Array(content()) } : {}) })
      const data = Buffer.from(await response.arrayBuffer())
      result = { status: response.status, headers: Object.fromEntries(response.headers), ...digest(data), ...(input.method === 'PROPFIND' ? { text: data.toString() } : {}) }
      break
    }
  }
  console.log(JSON.stringify(workerReplySchema.parse({ ok: true, result })))
}

if (process.argv.includes('--worker')) void main().catch(error => {
  const e = error as NodeJS.ErrnoException
  console.log(JSON.stringify(workerReplySchema.parse({ ok: false, error: e.message, code: e.code })))
})
