/**
 * Windows-only manual check of the auto-updater's signature verifier
 * (src/main/update-signature.ts) against real PowerShell and a real signed
 * Gamut installer, side by side with electron-updater's own verifier.
 *
 * Each case runs on a fresh copy of the installer, so Defender scans it again
 * the way it scans a just-downloaded update; the upstream column shows whether
 * this machine is slow enough to hit electron-updater's 20s limit.
 *
 * Verdicts: PASS = ours behaves as expected. PRE-EXISTING = ours and upstream
 * both miss the expectation (not caused by this change). FAIL = ours misses it
 * where upstream doesn't, or a security check failed. Exits 1 on any FAIL.
 *
 * Usage (PowerShell, repo root):
 *   npx tsx scripts/verify-update-signature.ts                      # downloads the current release installer
 *   npx tsx scripts/verify-update-signature.ts C:\path\Gamut-0.5.45-Setup.exe
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, writeFileSync, writeSync, closeSync, statSync } from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream } from 'stream/web'
import { verifySignature as upstreamVerifySignature } from 'electron-updater/out/windowsExecutableCodeSignatureVerifier'
import { verifyUpdateSignature } from '../src/main/update-signature'

const FEED_URL = 'https://updates.gamutagents.com/'
const PUBLISHER = 'Datawizz Inc.'

type Expect = 'valid' | 'rejected' | 'timeout'
type Outcome = { kind: 'valid' | 'rejected' | 'threw'; detail: string; ms: number }
type Row = { name: string; expect: Expect; ours: Outcome; upstream?: Outcome; verdict: 'PASS' | 'PRE-EXISTING' | 'FAIL'; note?: string }

const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

async function sha512Base64(file: string): Promise<string> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(file), hash)
  return hash.digest('base64')
}

async function downloadReleaseInstaller(dir: string): Promise<string> {
  const yml = await (await fetch(`${FEED_URL}latest.yml`)).text()
  const name = yml.match(/^path: (.+)$/m)?.[1].trim()
  const sha512 = yml.match(/^sha512: (.+)$/m)?.[1].trim()
  if (!name || !sha512) throw new Error(`Could not read path/sha512 from ${FEED_URL}latest.yml:\n${yml}`)
  const dest = path.join(dir, name)
  console.log(`Downloading ${name} from ${FEED_URL} …`)
  const res = await fetch(`${FEED_URL}${encodeURIComponent(name)}`)
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(dest))
  if ((await sha512Base64(dest)) !== sha512) throw new Error(`${dest} does not match the sha512 in latest.yml`)
  return dest
}

function signerSubject(file: string): string {
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}').SignerCertificate.Subject`,
  ], { encoding: 'utf8' }).trim()
}

async function outcome(run: () => Promise<string | null>): Promise<Outcome> {
  const startedAt = Date.now()
  try {
    const result = await run()
    return result === null
      ? { kind: 'valid', detail: 'null', ms: Date.now() - startedAt }
      : { kind: 'rejected', detail: result, ms: Date.now() - startedAt }
  } catch (err) {
    return { kind: 'threw', detail: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt }
  }
}

function meets(expect: Expect, o: Outcome): boolean {
  if (expect === 'valid') return o.kind === 'valid'
  if (expect === 'rejected') return o.kind !== 'valid'
  return o.kind === 'threw' && o.detail.startsWith('Timed out after')
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('This check drives PowerShell and Authenticode; run it on Windows.')
    process.exit(2)
  }

  const workDir = path.join(os.tmpdir(), `gamut-signature-check-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const installer = process.argv[2] ? path.resolve(process.argv[2]) : await downloadReleaseInstaller(workDir)
  console.log(`Installer: ${installer} (${(statSync(installer).size / 1048576).toFixed(0)} MiB)`)
  const subject = signerSubject(installer)
  console.log(`Signer subject: ${subject}\nWork dir: ${workDir}\n`)

  let copies = 0
  const freshCopy = (dirName: string, fileName = 'temp-Gamut-Setup.exe') => {
    const dir = path.join(workDir, `${++copies}-${dirName}`)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, fileName)
    copyFileSync(installer, file)
    return file
  }

  const rows: Row[] = []
  const record = (name: string, expect: Expect, ours: Outcome, upstream?: Outcome, note?: string) => {
    let verdict: Row['verdict'] = meets(expect, ours) ? 'PASS' : upstream && !meets(expect, upstream) ? 'PRE-EXISTING' : 'FAIL'
    if (note) verdict = 'FAIL'
    rows.push({ name, expect, ours, upstream, verdict, note })
    console.log(`${verdict.padEnd(12)} ${name}: ours ${ours.kind} in ${ours.ms}ms${upstream ? `, upstream ${upstream.kind} in ${upstream.ms}ms` : ''}${note ? ` — ${note}` : ''}`)
  }
  // Ours and upstream each get their own fresh copy, so both pay the cold-scan cost.
  const compare = async (name: string, expect: Expect, publishers: string[], prepare: () => string) => {
    const ours = await outcome(() => verifyUpdateSignature(publishers, prepare()))
    const upstream = await outcome(() => upstreamVerifySignature(publishers, prepare(), quietLogger as never))
    record(name, expect, ours, upstream)
  }

  await compare('cold copy, publisher CN', 'valid', [PUBLISHER], () => freshCopy('cold'))
  const warm = freshCopy('warm')
  await outcome(() => verifyUpdateSignature([PUBLISHER], warm)) // let Defender finish with it
  record('warm copy (second check of the same file)', 'valid', await outcome(() => verifyUpdateSignature([PUBLISHER], warm)))
  await compare('publisher as the full signer DN', 'valid', [subject], () => freshCopy('full-dn'))
  await compare('another publisher', 'rejected', ['Someone Else Inc.'], () => freshCopy('other-publisher'))
  await compare('full DN with a mismatched key', 'rejected', [`CN=${PUBLISHER}, C=ZZ`], () => freshCopy('dn-mismatch'))

  await compare('tampered installer (one byte flipped)', 'rejected', [PUBLISHER], () => {
    const file = freshCopy('tampered')
    const fd = openSync(file, 'r+')
    const at = Math.floor(statSync(file).size / 2)
    const byte = Buffer.alloc(1)
    readSync(fd, byte, 0, 1, at)
    byte[0] ^= 0xff
    writeSync(fd, byte, 0, 1, at)
    closeSync(fd)
    return file
  })

  await compare('not a PE file', 'rejected', [PUBLISHER], () => {
    const dir = path.join(workDir, `${++copies}-not-pe`)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'temp-Gamut-Setup.exe')
    writeFileSync(file, Buffer.from('MZ this is not a portable executable'))
    return file
  })

  // Paths like real user profiles: C:\Users\O'Brien, C:\Users\José, R&D folders.
  await compare("apostrophe in path (O'Brien)", 'valid', [PUBLISHER], () => freshCopy("O'Brien"))
  await compare('non-ASCII path (José 测试)', 'valid', [PUBLISHER], () => freshCopy('José 测试'))
  await compare('ampersand and spaces in path (R&D files)', 'valid', [PUBLISHER], () => freshCopy('R&D files'))

  // The path is spliced into a PowerShell string; a crafted name must not run.
  {
    const file = freshCopy('injection', "a';New-Item pwned.txt;'b.exe")
    const cwd = process.cwd()
    process.chdir(path.dirname(file))
    const ours = await outcome(() => verifyUpdateSignature([PUBLISHER], file))
    process.chdir(cwd)
    const injected = existsSync(path.join(path.dirname(file), 'pwned.txt'))
    record('command injection via file name', 'valid', ours, undefined, injected ? 'pwned.txt was created: the file name ran as a command' : undefined)
  }

  // Real PowerShell killed by the timeout: the error must be ours, not "Command failed".
  record(
    'forced timeout (100ms)',
    'timeout',
    await outcome(() => verifyUpdateSignature([PUBLISHER], freshCopy('timeout'), { timeoutMs: 100 })),
  )

  const reportFile = path.join(workDir, 'report.json')
  writeFileSync(reportFile, JSON.stringify({ installer, subject, machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGb: +(os.totalmem() / 2 ** 30).toFixed(1), release: os.release() }, rows }, null, 2))
  console.log('\n| Case | Expected | Ours | Upstream | Verdict |\n|---|---|---|---|---|')
  for (const r of rows) {
    const cell = (o?: Outcome) => (o ? `${o.kind} · ${o.ms}ms${o.kind === 'valid' ? '' : ` · ${o.detail.slice(0, 90).replace(/\s+/g, ' ').replace(/\|/g, '\\|')}`}` : '—')
    console.log(`| ${r.name} | ${r.expect} | ${cell(r.ours)} | ${cell(r.upstream)} | ${r.verdict}${r.note ? ` (${r.note})` : ''} |`)
  }
  console.log(`\nFull report: ${reportFile}`)
  process.exit(rows.some((r) => r.verdict === 'FAIL') ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
