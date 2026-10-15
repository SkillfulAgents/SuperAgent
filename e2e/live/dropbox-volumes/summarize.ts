import { readdir, readFile, writeFile } from 'node:fs/promises'
import { parseJson, stateSchema, reportSchema, summarySchema } from './schema'

async function main() {
  const output = process.env.DROPBOX_TEST_OUTPUT ?? '/tmp/gamut-dropbox-live'
  const state = parseJson(await readFile(`${output}/state.json`, 'utf8'), stateSchema)
  const files = (await readdir(output)).filter(file => file.startsWith(`${state.runName}-`) && file.endsWith('.json'))
  const reports = await Promise.all(files.map(async file => ({ file, report: parseJson(await readFile(`${output}/${file}`, 'utf8'), reportSchema) })))
  reports.sort((a, b) => a.report.startedAt.localeCompare(b.report.startedAt))
  const cases = new Map<string, (typeof summarySchema._output.cases)[number]>()
  for (const { file, report } of reports) for (const item of report.cases) cases.set(item.name, { ...item, report: file })
  const summary = summarySchema.parse({
    root: state.root, runName: state.runName, recordedAt: new Date().toISOString(),
    total: cases.size, passed: [...cases.values()].filter(item => item.passed).length,
    cases: [...cases.values()], reports: reports.map(item => item.file),
    downloads: reports.flatMap(item => item.report.downloads),
  })
  await writeFile(`${output}/validation.json`, JSON.stringify(summary, null, 2))
  console.log(`${summary.passed}/${summary.total} latest case results passed; ${summary.downloads.length} independent Dropbox downloads verified`)
  console.log(`${output}/validation.json`)
  console.log('Earlier failures remain in the individual attempt reports listed in this summary.')
  if (!summary.total || summary.passed !== summary.total) process.exitCode = 1
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
