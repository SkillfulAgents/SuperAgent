import { describe, it, expect } from 'vitest'
import * as path from 'path'

import { loadDailyUsageData as loadDailyUsageDataLightweight } from './usage-service'

const FIXTURES_DIR = path.resolve(__dirname, '__fixtures__/usage-data')

const AGENT_SLUGS = [
  '4b41c573-4c33-456d-9cc5-3df6ee95dc32', // has subagent files (agent-*)
  'fba8892d-17b2-4364-ac84-e27379bf021a', // mid-size, sonnet + haiku
  '573ca7e0-b1bf-471f-a7a9-ca8ddebcdb7d', // small, sonnet + haiku
  'github-3padfa',                          // opus 4.6
]

function getClaudePath(slug: string): string {
  return path.join(FIXTURES_DIR, slug)
}

/**
 * Load daily usage data via ccusage (the reference implementation).
 */
async function loadWithCcusage(claudePath: string, since?: string) {
  const { loadDailyUsageData } = await import('ccusage/data-loader')
  return loadDailyUsageData({ claudePath, since })
}

interface ModelBreakdown {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cost: number
}

interface DailyResult {
  date: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalCost: number
  modelBreakdowns: ModelBreakdown[]
}

/**
 * Normalize results for comparison: sort by date, sort model breakdowns by name.
 */
function normalize(data: DailyResult[]): DailyResult[] {
  return data
    .map((d) => ({
      date: d.date,
      totalCost: d.totalCost,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      cacheReadTokens: d.cacheReadTokens,
      modelBreakdowns: [...d.modelBreakdowns]
        .sort((a, b) => a.modelName.localeCompare(b.modelName))
        .map((mb) => ({
          modelName: mb.modelName,
          inputTokens: mb.inputTokens,
          outputTokens: mb.outputTokens,
          cacheCreationTokens: mb.cacheCreationTokens,
          cacheReadTokens: mb.cacheReadTokens,
          cost: mb.cost,
        })),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

describe('usage-service', () => {
  describe('loadDailyUsageData — matches ccusage token counts', () => {
    for (const slug of AGENT_SLUGS) {
      it(`matches ccusage for agent ${slug}`, async () => {
        const claudePath = getClaudePath(slug)

        const [ccusageResult, lightweightResult] = await Promise.all([
          loadWithCcusage(claudePath),
          loadDailyUsageDataLightweight({ claudePath }),
        ])

        const normalizedCcusage = normalize(ccusageResult as DailyResult[])
        const normalizedLightweight = normalize(lightweightResult)

        expect(normalizedLightweight.length).toBe(normalizedCcusage.length)

        for (let i = 0; i < normalizedCcusage.length; i++) {
          const cc = normalizedCcusage[i]
          const lw = normalizedLightweight[i]

          expect(lw.date).toBe(cc.date)
          expect(lw.inputTokens).toBe(cc.inputTokens)
          expect(lw.outputTokens).toBe(cc.outputTokens)
          expect(lw.cacheCreationTokens).toBe(cc.cacheCreationTokens)
          expect(lw.cacheReadTokens).toBe(cc.cacheReadTokens)

          // Costs must match (if these fail, run: npx tsx scripts/fetch-model-pricing.ts)
          expect(lw.totalCost).toBeCloseTo(cc.totalCost, 4)

          // Model breakdowns: token counts and costs must match
          expect(lw.modelBreakdowns.length).toBe(cc.modelBreakdowns.length)
          for (let j = 0; j < cc.modelBreakdowns.length; j++) {
            expect(lw.modelBreakdowns[j].modelName).toBe(cc.modelBreakdowns[j].modelName)
            expect(lw.modelBreakdowns[j].inputTokens).toBe(cc.modelBreakdowns[j].inputTokens)
            expect(lw.modelBreakdowns[j].outputTokens).toBe(cc.modelBreakdowns[j].outputTokens)
            expect(lw.modelBreakdowns[j].cacheCreationTokens).toBe(cc.modelBreakdowns[j].cacheCreationTokens)
            expect(lw.modelBreakdowns[j].cacheReadTokens).toBe(cc.modelBreakdowns[j].cacheReadTokens)
            expect(lw.modelBreakdowns[j].cost).toBeCloseTo(cc.modelBreakdowns[j].cost, 4)
          }
        }
      })
    }
  })

  describe('loadDailyUsageData — since filter', () => {
    it('filters entries by since date', async () => {
      // Agent 4b41 has data across 3 days: 2025-12-04, 2025-12-05, 2025-12-06
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')

      const allData = await loadDailyUsageDataLightweight({ claudePath })
      const filteredData = await loadDailyUsageDataLightweight({ claudePath, since: '20251206' })

      expect(allData.length).toBeGreaterThanOrEqual(2)
      expect(filteredData.length).toBe(1)
      expect(filteredData[0].date).toBe('2025-12-06')
    })

    it('since filter matches ccusage output', async () => {
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')
      const since = '20251205'

      const [ccusageResult, lightweightResult] = await Promise.all([
        loadWithCcusage(claudePath, since),
        loadDailyUsageDataLightweight({ claudePath, since }),
      ])

      const normalizedCcusage = normalize(ccusageResult as DailyResult[])
      const normalizedLightweight = normalize(lightweightResult)

      expect(normalizedLightweight.length).toBe(normalizedCcusage.length)
      for (let i = 0; i < normalizedCcusage.length; i++) {
        expect(normalizedLightweight[i].date).toBe(normalizedCcusage[i].date)
        expect(normalizedLightweight[i].inputTokens).toBe(normalizedCcusage[i].inputTokens)
        expect(normalizedLightweight[i].outputTokens).toBe(normalizedCcusage[i].outputTokens)
      }
    })
  })

  describe('loadDailyUsageData — empty/missing directory', () => {
    it('returns empty array for non-existent path', async () => {
      const result = await loadDailyUsageDataLightweight({
        claudePath: '/tmp/nonexistent-usage-test-path',
      })
      expect(result).toEqual([])
    })
  })

  describe('loadDailyUsageData — deduplication', () => {
    it('produces consistent results (idempotent dedup)', async () => {
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')
      const result1 = await loadDailyUsageDataLightweight({ claudePath })
      const result2 = await loadDailyUsageDataLightweight({ claudePath })
      expect(normalize(result1)).toEqual(normalize(result2))
    })
  })

  describe('loadDailyUsageData — subagent files', () => {
    it('includes usage from subagent (agent-*) files', async () => {
      // Agent 4b41 has agent-*.jsonl files alongside regular session files
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')
      const result = await loadDailyUsageDataLightweight({ claudePath })

      // Verify we have data (subagent tokens should be counted)
      const totalTokens = result.reduce(
        (sum, d) => sum + d.inputTokens + d.outputTokens,
        0
      )
      expect(totalTokens).toBeGreaterThan(0)

      // Compare against ccusage to verify subagent data is included equally
      const ccusageResult = await loadWithCcusage(claudePath)
      const ccTotalTokens = (ccusageResult as DailyResult[]).reduce(
        (sum, d) => sum + d.inputTokens + d.outputTokens,
        0
      )
      expect(totalTokens).toBe(ccTotalTokens)
    })
  })

  describe('loadDailyUsageData — costUSD field', () => {
    it('uses costUSD from entries when available', async () => {
      const claudePath = getClaudePath('bedrock-agent')
      const result = await loadDailyUsageDataLightweight({ claudePath })

      const sorted = normalize(result)

      // 2025-12-05: two entries with costUSD 0.0023 + 0.0045 = 0.0068
      expect(sorted[0].date).toBe('2025-12-05')
      expect(sorted[0].totalCost).toBeCloseTo(0.0068, 6)

      // 2025-12-06: one entry with costUSD 0.0005
      expect(sorted[1].date).toBe('2025-12-06')
      expect(sorted[1].totalCost).toBeCloseTo(0.0005, 6)
    })

    it('preserves Bedrock model names for downstream normalization', async () => {
      const claudePath = getClaudePath('bedrock-agent')
      const result = await loadDailyUsageDataLightweight({ claudePath })

      const allModels = result.flatMap((d) => d.modelBreakdowns.map((mb) => mb.modelName))
      // Should keep the raw Bedrock model name — normalization happens in the route
      expect(allModels).toContain('us.anthropic.claude-sonnet-4-5-20250929-v1')
      expect(allModels).toContain('global.anthropic.claude-haiku-4-5-20251001')
    })

    it('aggregates cost per model breakdown', async () => {
      const claudePath = getClaudePath('bedrock-agent')
      const result = await loadDailyUsageDataLightweight({ claudePath })

      const dec5 = result.find((d) => d.date === '2025-12-05')!
      const sonnetBreakdown = dec5.modelBreakdowns.find((mb) =>
        mb.modelName === 'us.anthropic.claude-sonnet-4-5-20250929-v1'
      )!
      expect(sonnetBreakdown.cost).toBeCloseTo(0.0068, 6)
      expect(sonnetBreakdown.inputTokens).toBe(1100)
      expect(sonnetBreakdown.outputTokens).toBe(250)
    })
  })

  describe('loadDailyUsageData — hardcoded pricing for standard models', () => {
    it('computes non-zero costs for known Claude models', async () => {
      // Agent 4b41 uses claude-sonnet-4-5-20250929 and claude-haiku-4-5-20251001
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')
      const result = await loadDailyUsageDataLightweight({ claudePath })

      const totalCost = result.reduce((sum, d) => sum + d.totalCost, 0)
      expect(totalCost).toBeGreaterThan(0)

      // Check that each model breakdown has a cost
      for (const day of result) {
        for (const mb of day.modelBreakdowns) {
          const totalTokens = mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens
          if (totalTokens > 0) {
            expect(mb.cost).toBeGreaterThan(0)
          }
        }
      }
    })

    it('prefers costUSD over hardcoded pricing', async () => {
      // Bedrock fixture has costUSD — should use that, not hardcoded pricing
      const claudePath = getClaudePath('bedrock-agent')
      const result = await loadDailyUsageDataLightweight({ claudePath })

      const dec5 = result.find((d) => d.date === '2025-12-05')!
      // costUSD was 0.0023 + 0.0045 = 0.0068
      // Hardcoded pricing would give a different number
      expect(dec5.totalCost).toBeCloseTo(0.0068, 6)
    })
  })

  describe('loadDailyUsageData — edge cases', () => {
    const edgePath = getClaudePath('edge-cases')

    it('skips non-usage lines (queue-operation, user messages, malformed JSON)', async () => {
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })
      // Should not crash — malformed lines and non-usage entries are silently skipped
      expect(result.length).toBeGreaterThan(0)
    })

    it('deduplicates entries across files', async () => {
      // msg_dup1/req_dup1 appears in both session-a.jsonl and session-b.jsonl
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      // opus-4-6 entries: msg_dup1 (100in/50out, deduplicated), msg_002 (200/100), msg_005 (400/200 costUSD=0)
      const opusBreakdown = dec10.modelBreakdowns.find((mb) => mb.modelName === 'claude-opus-4-6')!
      // 100 + 200 + 400 = 700 input (not 800 — dup was skipped)
      expect(opusBreakdown.inputTokens).toBe(700)
      // 50 + 100 + 200 = 350 output
      expect(opusBreakdown.outputTokens).toBe(350)
    })

    it('falls back to "unknown" for entries without a model field', async () => {
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      const unknownBreakdown = dec10.modelBreakdowns.find((mb) => mb.modelName === 'unknown')
      expect(unknownBreakdown).toBeDefined()
      expect(unknownBreakdown!.inputTokens).toBe(50)
      expect(unknownBreakdown!.outputTokens).toBe(25)
      // Unknown model → cost should be 0
      expect(unknownBreakdown!.cost).toBe(0)
    })

    it('returns cost 0 for unknown models', async () => {
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      const unknownModel = dec10.modelBreakdowns.find((mb) => mb.modelName === 'totally-unknown-model')
      expect(unknownModel).toBeDefined()
      expect(unknownModel!.inputTokens).toBe(300)
      expect(unknownModel!.cost).toBe(0)
    })

    it('uses explicit costUSD: 0 instead of computing from pricing table', async () => {
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      // msg_005 has costUSD: 0 on a claude-opus-4-6 entry (400 input, 200 output)
      // Without costUSD, hardcoded pricing would give (400*5 + 200*25)/1e6 = 0.007
      // But costUSD: 0 is explicit — should use that
      const opusBreakdown = dec10.modelBreakdowns.find((mb) => mb.modelName === 'claude-opus-4-6')!
      // Total cost for opus: msg_dup1 computed + msg_002 computed + msg_005 explicit 0
      // msg_dup1: (100*5 + 50*25)/1e6 = 0.001750
      // msg_002: (200*5 + 100*25)/1e6 = 0.003500
      // msg_005: 0 (explicit costUSD)
      expect(opusBreakdown.cost).toBeCloseTo(0.00525, 6)
    })

    it('uses costUSD from bedrock entry alongside computed entries', async () => {
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      // msg_006 has costUSD: 0.05 for a bedrock model
      const bedrockBreakdown = dec10.modelBreakdowns.find(
        (mb) => mb.modelName === 'us.anthropic.claude-opus-4-6-v1'
      )
      expect(bedrockBreakdown).toBeDefined()
      expect(bedrockBreakdown!.cost).toBeCloseTo(0.05, 6)
    })

    it('aggregates across multiple days from different files', async () => {
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })

      // session-b.jsonl has an entry on 2025-12-11
      const dec11 = result.find((d) => d.date === '2025-12-11')
      expect(dec11).toBeDefined()
      expect(dec11!.modelBreakdowns[0].modelName).toBe('claude-sonnet-4-6')
      expect(dec11!.inputTokens).toBe(600)
      expect(dec11!.cacheCreationTokens).toBe(100)
      expect(dec11!.cacheReadTokens).toBe(200)
    })
  })
})
