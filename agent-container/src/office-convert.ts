import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { KILL_GRACE_MS, killProcessGroup } from './widget-manager'

const CONVERTIBLE = new Set(['.pptx'])
// From arrival, waiting included, so a queued deck still answers before the cloud proxy re-sends it. The largest deck measured took 10 s.
const TIMEOUT_MS = 20_000
// A crafted 32 KB deck reached 1 GB; under this cap LibreOffice drops the image and still converts.
const ADDRESS_SPACE_KB = 1_500_000

// A fresh profile per conversion: no fetching linked images, no macros, and
// hidden slides kept so PDF page N is slide N.
const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Filter/PDF/Export"><prop oor:name="ExportHiddenSlides" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`

export type ConvertResult =
  | { ok: true; pdf: Buffer }
  | { ok: false; reason: 'unsupported' | 'timeout' | 'unreadable' }

let queue: Promise<unknown> = Promise.resolve()

/** One LibreOffice at a time: each is capped at ADDRESS_SPACE_KB, and the container shares 4 GB with Chromium. */
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run)
  queue = next.catch(() => {})
  return next
}

export async function convertToPdf(filePath: string, signal?: AbortSignal): Promise<ConvertResult> {
  if (!CONVERTIBLE.has(path.extname(filePath).toLowerCase())) return { ok: false, reason: 'unsupported' }
  const deadline = Date.now() + TIMEOUT_MS
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'office-convert-'))
  try {
    const profile = path.join(dir, 'profile')
    await fs.promises.mkdir(path.join(profile, 'user'), { recursive: true })
    await fs.promises.writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), PROFILE)
    const outDir = path.join(dir, 'out')
    const finished = await oneAtATime(() => {
      // A preview closed or out of time while it waited needs no conversion.
      const left = deadline - Date.now()
      if (signal?.aborted || left <= 0) return Promise.resolve(false)
      return runSoffice([
        `-env:UserInstallation=file://${profile}`,
        '--headless', '--norestore', '--nolockcheck',
        '--convert-to', 'pdf', '--outdir', outDir, filePath,
      ], left)
    })
    if (!finished) return { ok: false, reason: 'timeout' }
    const pdfName = `${path.basename(filePath, path.extname(filePath))}.pdf`
    const pdf = await fs.promises.readFile(path.join(outDir, pdfName)).catch(() => null)
    return pdf ? { ok: true, pdf } : { ok: false, reason: 'unreadable' }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

/** Resolves false when the timeout killed it. soffice starts children, so it runs in its own group. */
function runSoffice(args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', `ulimit -v ${ADDRESS_SPACE_KB} && exec soffice "$@"`, 'soffice', ...args], {
      stdio: 'ignore',
      detached: true,
    })
    let timedOut = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      killProcessGroup(proc, process.stderr)
      // The queue advances on this promise: give up on an exit that never comes.
      graceTimer = setTimeout(() => resolve(false), KILL_GRACE_MS)
    }, timeoutMs)
    const settle = () => {
      clearTimeout(timer)
      clearTimeout(graceTimer)
    }
    proc.on('error', (error) => {
      settle()
      reject(error)
    })
    proc.on('exit', () => {
      settle()
      resolve(!timedOut)
    })
  })
}
