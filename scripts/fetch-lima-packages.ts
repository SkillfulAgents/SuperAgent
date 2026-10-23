// Download the Alpine packages a new Lima VM installs on first boot
// (src/shared/lib/container/lima-packages.json, plus their dependencies) into
// a local apk repository that ships in the app, so the VM downloads nothing.
//
// Plain HTTPS and no VM: it runs wherever download-lima.sh runs, CI's macOS
// runners included, which can't boot a VM to bake a custom image.
//
// Usage: tsx scripts/fetch-lima-packages.ts <alpine-branch, e.g. v3.23> <arch, e.g. aarch64> <out-dir>
//
// Output: <out-dir>/{main,community}/<arch>/ each holding Alpine's signed
// APKINDEX.tar.gz exactly as published, plus the selected .apk files. apk in
// the VM checks the index signature against the image's Alpine keys and each
// package against the index. <out-dir>/packages.txt lists name-version.
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { parseApkIndex, resolvePackages, type ApkIndexEntry } from './lib/alpine-packages'
import limaPackages from '../src/shared/lib/container/lima-packages.json'

const MIRROR = 'https://dl-cdn.alpinelinux.org/alpine'
const REPOS = ['main', 'community'] as const

async function download(url: string, attempts = 3): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Download failed after ${attempts} attempts: ${url}: ${(error as Error).message}`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
}

/** The APKINDEX file inside APKINDEX.tar.gz (gzip members: the signature tar, then the index tar). */
function readIndexText(tarGz: Buffer): string {
  const tar = zlib.gunzipSync(tarGz)
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '')
    if (!name) {
      offset += 512 // padding or end-of-archive block
      continue
    }
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim(), 8)
    const body = offset + 512
    if (name === 'APKINDEX') return tar.subarray(body, body + size).toString('utf8')
    offset = body + Math.ceil(size / 512) * 512
  }
  throw new Error('No APKINDEX in the index archive')
}

async function main(): Promise<void> {
  const [branch, arch, outDir] = process.argv.slice(2)
  if (!branch || !arch || !outDir) {
    console.error('Usage: tsx scripts/fetch-lima-packages.ts <alpine-branch> <arch> <out-dir>')
    process.exit(2)
  }

  const indexes = new Map<string, Buffer>()
  const entries: ApkIndexEntry[] = []
  for (const repo of REPOS) {
    const tarGz = await download(`${MIRROR}/${branch}/${repo}/${arch}/APKINDEX.tar.gz`)
    indexes.set(repo, tarGz)
    entries.push(...parseApkIndex(readIndexText(tarGz), repo))
  }
  const selected = resolvePackages(entries, limaPackages.packages)

  fs.rmSync(outDir, { recursive: true, force: true })
  for (const repo of REPOS) {
    const dir = path.join(outDir, repo, arch)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'APKINDEX.tar.gz'), indexes.get(repo)!)
  }

  // A few at a time; each is checked against the size the index records.
  const queue = [...selected]
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const file = `${entry.name}-${entry.version}.apk`
      const data = await download(`${MIRROR}/${branch}/${entry.repo}/${arch}/${file}`)
      if (data.length !== entry.size) {
        throw new Error(`${file} is ${data.length} bytes, but the index says ${entry.size}`)
      }
      fs.writeFileSync(path.join(outDir, entry.repo, arch, file), data)
    }
  }))

  fs.writeFileSync(path.join(outDir, 'packages.txt'), selected.map((e) => `${e.name}-${e.version}`).join('\n') + '\n')
  const totalMb = selected.reduce((sum, e) => sum + e.size, 0) / 1048576
  console.log(`  packages: ${selected.length} for ${limaPackages.packages.join(' ')} (${totalMb.toFixed(1)} MiB)`)
}

main().catch((error) => {
  console.error(`ERROR: ${(error as Error).message}`)
  process.exit(1)
})
