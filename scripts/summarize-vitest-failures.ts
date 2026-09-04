import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vitestReportSchema, type VitestReport } from './vitest-report-schema'

// Renders vitest's JSON report as a GitHub Actions step summary, so a failing
// unit-test job says what broke on the run page itself instead of only at the
// bottom of a several-thousand-line step log.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = path.resolve(repoRoot, process.argv[2] ?? 'test-results/unit/vitest-results.json')

const MAX_FAILURES_LISTED = 40
const MAX_MESSAGE_LINES = 16
const MAX_MESSAGE_CHARS = 2_000
const MAX_STACK_FRAMES = 4

// Built from a char code so the ESC byte never appears literally in this file.
const ESC = String.fromCharCode(27)
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

function relative(file: string): string {
  const rel = path.relative(repoRoot, file)
  return rel.startsWith('..') ? file : rel
}

// vitest hands the JSON reporter `error.stack`: the assertion message, then a
// stack that is nearly all vitest-runner frames. Keep the message and only the
// frames inside this repo — the full stack and the value diff are still in the
// step log and in the annotation the github-actions reporter emits.
function trimMessage(message: string): string {
  const lines = stripAnsi(message).trimEnd().split('\n')
  const kept: string[] = []
  let projectFrames = 0

  for (const line of lines) {
    const frame = line.match(/^\s+at\s+(?:.*\()?(?:file:\/\/)?(\/[^)]+)\)?$/)
    if (!frame) {
      if (projectFrames === 0) kept.push(line)
      continue
    }
    const location = relative(frame[1].replace(/^file:\/\//, ''))
    if (location.startsWith('/') || location.startsWith('node_modules/')) continue
    if (projectFrames >= MAX_STACK_FRAMES) continue
    kept.push(`    at ${location}`)
    projectFrames += 1
  }

  const body = (kept.length > 0 ? kept : lines).slice(0, MAX_MESSAGE_LINES)
  return body.join('\n').trimEnd().slice(0, MAX_MESSAGE_CHARS)
}

function emit(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    appendFileSync(summaryPath, `${markdown}\n`)
  } else {
    process.stdout.write(`${markdown}\n`)
  }
}

type ReadResult =
  | { kind: 'ok'; report: VitestReport }
  | { kind: 'missing' }
  | { kind: 'unreadable'; detail: string }

function readReport(): ReadResult {
  let raw: string
  try {
    raw = readFileSync(reportPath, 'utf-8')
  } catch {
    return { kind: 'missing' }
  }
  try {
    return { kind: 'ok', report: vitestReportSchema.parse(JSON.parse(raw)) }
  } catch (error) {
    return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
}

const result = readReport()

// Never fail this step on a bad report: the test step's own exit code already
// decides the job, and a summary that throws would bury the real failure.
if (result.kind !== 'ok') {
  const why =
    result.kind === 'missing'
      ? 'the run most likely crashed before writing one'
      : `it could not be parsed: ${result.detail}`
  emit(
    [
      '## Unit tests',
      '',
      `No usable vitest report at \`${relative(reportPath)}\` — ${why}.`,
      'Open the step log for the raw output.',
    ].join('\n')
  )
  process.exit(0)
}

const report = result.report

const counts = `**${report.numPassedTests} passed** · **${report.numFailedTests} failed** · ${report.numPendingTests} skipped · ${report.numTotalTests} total`

if (report.success && report.numFailedTests === 0) {
  emit(['## Unit tests — all green', '', counts].join('\n'))
  process.exit(0)
}

const lines: string[] = ['## Unit tests failed', '', counts, '']
let listed = 0
let omitted = 0

for (const file of report.testResults) {
  const failures = file.assertionResults.filter((assertion) => assertion.status === 'failed')

  // A file that never produced an assertion but still failed blew up on import
  // or in a top-level hook; its only diagnostic is the file-level message.
  if (failures.length === 0) {
    if (file.status !== 'failed') continue
    lines.push(`### \`${relative(file.name)}\``, '', 'The test file failed before any test ran.', '')
    if (file.message.trim()) {
      lines.push('```', trimMessage(file.message), '```', '')
    }
    listed += 1
    continue
  }

  // Past the cap, count the rest rather than emitting a header with nothing
  // under it.
  if (listed >= MAX_FAILURES_LISTED) {
    omitted += failures.length
    continue
  }

  lines.push(`### \`${relative(file.name)}\``, '')
  for (const failure of failures) {
    if (listed >= MAX_FAILURES_LISTED) {
      omitted += 1
      continue
    }
    const name = [...failure.ancestorTitles, failure.title].filter(Boolean).join(' > ') || failure.fullName
    const where = failure.location ? ` — line ${failure.location.line}` : ''
    lines.push(`- **${name}**${where}`)
    const message = failure.failureMessages.map(trimMessage).filter(Boolean).join('\n')
    if (message) {
      lines.push('', '```', message, '```')
    }
    listed += 1
  }
  lines.push('')
}

if (omitted > 0) {
  lines.push(`_...and ${omitted} more failing test(s). See the step log for the full output._`)
}

emit(lines.join('\n'))
