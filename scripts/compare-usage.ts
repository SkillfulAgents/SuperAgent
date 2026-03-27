import * as path from 'path'
import * as fs from 'fs'
import { loadDailyUsageData as loadOurs } from '../src/shared/lib/services/usage-service'

async function loadCcusage(claudePath: string) {
  const { loadDailyUsageData } = await import('ccusage/data-loader')
  return loadDailyUsageData({ claudePath })
}

async function main() {
  const fixturesDir = path.resolve('src/shared/lib/services/__fixtures__/usage-data')
  const agents = fs.readdirSync(fixturesDir).filter((f) =>
    fs.statSync(path.join(fixturesDir, f)).isDirectory()
  )

  let totalDays = 0
  let mismatches = 0

  for (const slug of agents) {
    const claudePath = path.join(fixturesDir, slug)

    let ccData: any[]
    let ourData: Awaited<ReturnType<typeof loadOurs>>
    try {
      ;[ccData, ourData] = await Promise.all([loadCcusage(claudePath), loadOurs({ claudePath })])
    } catch (e: any) {
      console.log('SKIP ' + slug + ': ' + e.message)
      continue
    }

    ccData.sort((a: any, b: any) => a.date.localeCompare(b.date))
    ourData.sort((a, b) => a.date.localeCompare(b.date))

    if (ccData.length !== ourData.length) {
      console.log(
        'MISMATCH ' + slug + ': ccusage=' + ccData.length + ' days, ours=' + ourData.length
      )
      mismatches++
      continue
    }

    let agentOk = true
    for (let i = 0; i < ccData.length; i++) {
      const cc = ccData[i]
      const lw = ourData[i]
      totalDays++

      const checks: [string, any, any][] = [
        ['date', cc.date, lw.date],
        ['inputTokens', cc.inputTokens, lw.inputTokens],
        ['outputTokens', cc.outputTokens, lw.outputTokens],
        ['cacheCreation', cc.cacheCreationTokens, lw.cacheCreationTokens],
        ['cacheRead', cc.cacheReadTokens, lw.cacheReadTokens],
        ['totalCost', cc.totalCost, lw.totalCost],
      ]

      for (const [name, expected, actual] of checks) {
        if (typeof expected === 'number' && typeof actual === 'number') {
          if (Math.abs(expected - actual) > 0.000001) {
            console.log(
              `MISMATCH ${slug} ${cc.date} ${name}: cc=${expected} ours=${actual}`
            )
            agentOk = false
            mismatches++
          }
        } else if (expected !== actual) {
          console.log(`MISMATCH ${slug} ${cc.date} ${name}: cc=${expected} ours=${actual}`)
          agentOk = false
          mismatches++
        }
      }

      // Check model breakdowns
      const ccModels = [...cc.modelBreakdowns].sort((a: any, b: any) =>
        a.modelName.localeCompare(b.modelName)
      )
      const lwModels = [...lw.modelBreakdowns].sort((a, b) =>
        a.modelName.localeCompare(b.modelName)
      )

      if (ccModels.length !== lwModels.length) {
        console.log(
          `MISMATCH ${slug} ${cc.date} modelBreakdowns count: cc=${ccModels.length} ours=${lwModels.length}`
        )
        mismatches++
        agentOk = false
      } else {
        for (let j = 0; j < ccModels.length; j++) {
          const fields = [
            'modelName',
            'inputTokens',
            'outputTokens',
            'cacheCreationTokens',
            'cacheReadTokens',
            'cost',
          ] as const
          for (const f of fields) {
            const cv = (ccModels[j] as any)[f]
            const lv = (lwModels[j] as any)[f]
            if (typeof cv === 'number' && typeof lv === 'number') {
              if (Math.abs(cv - lv) > 0.000001) {
                console.log(
                  `MISMATCH ${slug} ${cc.date} ${ccModels[j].modelName}.${f}: cc=${cv} ours=${lv}`
                )
                mismatches++
                agentOk = false
              }
            } else if (cv !== lv) {
              console.log(
                `MISMATCH ${slug} ${cc.date} model.${f}: cc=${cv} ours=${lv}`
              )
              mismatches++
              agentOk = false
            }
          }
        }
      }
    }

    if (agentOk) {
      console.log(`OK ${slug} (${ccData.length} days)`)
    }
  }

  console.log('')
  console.log(
    `Total: ${agents.length} agents, ${totalDays} day-entries checked, ${mismatches} mismatches`
  )
  if (mismatches > 0) process.exit(1)
}

main()
