import { beforeEach, describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import { loadDailyUsageData as loadDailyUsageDataLightweight, calculateCost } from './usage-service'

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
  beforeEach(() => {
    settingsMock.mockReturnValue({ llmProvider: 'anthropic' })
  })

  describe('loadDailyUsageData — matches ccusage stable token counts', () => {
    for (const slug of AGENT_SLUGS) {
      it(`matches ccusage stable counts for agent ${slug}`, async () => {
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
          // ccusage keeps the first snapshot for duplicate assistant message IDs.
          // We keep the highest output_tokens snapshot, so output/cost can be higher.
          expect(lw.outputTokens).toBeGreaterThanOrEqual(cc.outputTokens)
          expect(lw.cacheCreationTokens).toBe(cc.cacheCreationTokens)
          expect(lw.cacheReadTokens).toBe(cc.cacheReadTokens)

          expect(lw.totalCost).toBeGreaterThanOrEqual(cc.totalCost - 1e-10)

          // Model breakdowns: token counts and costs must match
          expect(lw.modelBreakdowns.length).toBe(cc.modelBreakdowns.length)
          for (let j = 0; j < cc.modelBreakdowns.length; j++) {
            expect(lw.modelBreakdowns[j].modelName).toBe(cc.modelBreakdowns[j].modelName)
            expect(lw.modelBreakdowns[j].inputTokens).toBe(cc.modelBreakdowns[j].inputTokens)
            expect(lw.modelBreakdowns[j].outputTokens).toBeGreaterThanOrEqual(cc.modelBreakdowns[j].outputTokens)
            expect(lw.modelBreakdowns[j].cacheCreationTokens).toBe(cc.modelBreakdowns[j].cacheCreationTokens)
            expect(lw.modelBreakdowns[j].cacheReadTokens).toBe(cc.modelBreakdowns[j].cacheReadTokens)
            expect(lw.modelBreakdowns[j].cost).toBeGreaterThanOrEqual(cc.modelBreakdowns[j].cost - 1e-10)
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

  describe('calculateCost — GPT pricing + 272K long-context cliff', () => {
    it('prices GPT models that are absent from the old Claude-only table (was $0)', () => {
      // 100K input, 1K output, below the cliff: $5 input / $30 output per 1M.
      expect(calculateCost('gpt-5.5', 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * 5 + 1_000 * 30) / 1_000_000,
        9,
      )
      // OpenRouter-prefixed id resolves too.
      expect(calculateCost('openai/gpt-5.4', 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * 2.5 + 1_000 * 15) / 1_000_000,
        9,
      )
    })

    it('reprices the whole request above 272K input (2x input / 1.5x output)', () => {
      expect(calculateCost('gpt-5.5', 300_000, 2_000, 0, 0)).toBeCloseTo(
        (300_000 * 10 + 2_000 * 45) / 1_000_000,
        9,
      )
      expect(calculateCost('gpt-5.4', 300_000, 2_000, 0, 0)).toBeCloseTo(
        (300_000 * 5 + 2_000 * 22.5) / 1_000_000,
        9,
      )
    })

    it('counts cache reads toward the threshold (cliff is on full prompt input)', () => {
      // 50K fresh + 250K cache reads = 300K prompt input → over 272K.
      expect(calculateCost('gpt-5.5', 50_000, 0, 0, 250_000)).toBeCloseTo(
        (50_000 * 10 + 250_000 * 1) / 1_000_000,
        9,
      )
    })

    it('stays on the short rate exactly at 272K (cliff is strictly >)', () => {
      expect(calculateCost('gpt-5.5', 272_000, 0, 0, 0)).toBeCloseTo(
        (272_000 * 5) / 1_000_000,
        9,
      )
    })

    it('Claude models have no cliff — large prompts stay linear', () => {
      expect(calculateCost('claude-opus-4-6', 500_000, 10_000, 0, 0)).toBeCloseTo(
        (500_000 * 5 + 10_000 * 25) / 1_000_000,
        9,
      )
    })

    it('returns 0 for unknown models', () => {
      expect(calculateCost('totally-unknown', 100_000, 1_000, 0, 0)).toBe(0)
    })

    it('uses a patched built-in price from the effective provider catalog', () => {
      settingsMock.mockReturnValue({
        modelCatalog: {
          platform: {
            overrides: [{ id: 'gpt-5.5', pricing: { inputPerMtok: 6, outputPerMtok: 36 } }],
          },
        },
      })

      expect(calculateCost('gpt-5.5', 100_000, 1_000, 0, 0, 'platform')).toBeCloseTo(
        (100_000 * 6 + 1_000 * 36) / 1_000_000,
        9,
      )
    })

    it('uses net-new custom model pricing and returns 0 when pricing is absent', () => {
      settingsMock.mockReturnValue({
        modelCatalog: {
          anthropic: {
            overrides: [
              {
                id: 'custom-priced-1',
                label: 'Custom Priced',
                supportedEfforts: ['low'],
                pricing: { inputPerMtok: 1, outputPerMtok: 2 },
              },
              {
                id: 'custom-freeform-1',
                label: 'Custom Freeform',
                supportedEfforts: ['low'],
              },
            ],
          },
        },
      })

      expect(calculateCost('custom-priced-1', 100_000, 1_000, 0, 0, 'anthropic')).toBeCloseTo(
        (100_000 * 1 + 1_000 * 2) / 1_000_000,
        9,
      )
      expect(calculateCost('custom-freeform-1', 100_000, 1_000, 0, 0, 'anthropic')).toBe(0)
    })

    it('honors a patched custom long-context cliff', () => {
      settingsMock.mockReturnValue({
        modelCatalog: {
          anthropic: {
            overrides: [
              {
                id: 'custom-cliff-1',
                label: 'Custom Cliff',
                supportedEfforts: ['low'],
                pricing: { inputPerMtok: 1, outputPerMtok: 2 },
                longContextPriceCliff: {
                  thresholdTokens: 100,
                  inputMultiplier: 3,
                  outputMultiplier: 4,
                },
              },
            ],
          },
        },
      })

      expect(calculateCost('custom-cliff-1', 200, 10, 0, 0, 'anthropic')).toBeCloseTo(
        (200 * 3 + 10 * 8) / 1_000_000,
        9,
      )
    })

    it('keeps pricing patches isolated by provider', () => {
      settingsMock.mockReturnValue({
        modelCatalog: {
          anthropic: {
            overrides: [{ id: 'claude-opus-4-8', pricing: { inputPerMtok: 9, outputPerMtok: 45 } }],
          },
        },
      })

      expect(calculateCost('claude-opus-4-8', 100_000, 1_000, 0, 0, 'anthropic')).toBeCloseTo(
        (100_000 * 9 + 1_000 * 45) / 1_000_000,
        9,
      )
      expect(calculateCost('claude-opus-4-8', 100_000, 1_000, 0, 0, 'openrouter')).toBeCloseTo(
        (100_000 * 5 + 1_000 * 25) / 1_000_000,
        9,
      )
    })
  })

  describe('loadDailyUsageData — edge cases', () => {
    const edgePath = getClaudePath('edge-cases')

    it('skips non-usage lines (queue-operation, user messages, malformed JSON)', async () => {
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })
      // Should not crash — malformed lines and non-usage entries are silently skipped
      expect(result.length).toBeGreaterThan(0)
    })

    it('deduplicates entries across files and keeps the highest output_tokens snapshot', async () => {
      // msg_dup1/req_dup1 appears multiple times with output snapshots 50, 75, and 50.
      const result = await loadDailyUsageDataLightweight({ claudePath: edgePath })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      // opus-4-6 entries: msg_dup1 (100in/75out, highest kept), msg_002 (200/100), msg_005 (400/200 costUSD=0)
      const opusBreakdown = dec10.modelBreakdowns.find((mb) => mb.modelName === 'claude-opus-4-6')!
      // 100 + 200 + 400 = 700 input (not 800 — dup was skipped)
      expect(opusBreakdown.inputTokens).toBe(700)
      // 75 + 100 + 200 = 375 output
      expect(opusBreakdown.outputTokens).toBe(375)
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
      // msg_dup1: (100*5 + 75*25)/1e6 = 0.002375
      // msg_002: (200*5 + 100*25)/1e6 = 0.003500
      // msg_005: 0 (explicit costUSD)
      expect(opusBreakdown.cost).toBeCloseTo(0.005875, 6)
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

  describe('loadDailyUsageData — served speed tiers', () => {
    let seq = 0

    interface EntryOpts {
      speed?: string
      costUSD?: number
      input?: number
      output?: number
      cacheCreation?: number
      cacheRead?: number
    }

    function makeEntry(model: string, opts: EntryOpts = {}) {
      seq += 1
      return {
        timestamp: '2026-07-01T12:00:00.000Z',
        requestId: `req-${seq}`,
        ...(opts.costUSD !== undefined ? { costUSD: opts.costUSD } : {}),
        message: {
          id: `msg-${seq}`,
          model,
          usage: {
            input_tokens: opts.input ?? 100_000,
            output_tokens: opts.output ?? 1_000,
            ...(opts.cacheCreation !== undefined
              ? { cache_creation_input_tokens: opts.cacheCreation }
              : {}),
            ...(opts.cacheRead !== undefined ? { cache_read_input_tokens: opts.cacheRead } : {}),
            ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
          },
        },
      }
    }

    /** Load a single synthetic entry and return its total cost. */
    async function costOf(
      model: string,
      opts: EntryOpts = {},
      providerId?: 'platform' | 'anthropic',
    ): Promise<number> {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-speed-'))
      try {
        mkdirSync(path.join(dir, 'projects'), { recursive: true })
        writeFileSync(
          path.join(dir, 'projects', 'session.jsonl'),
          `${JSON.stringify(makeEntry(model, opts))}\n`,
        )
        const result = await loadDailyUsageDataLightweight({
          claudePath: dir,
          ...(providerId ? { providerId } : {}),
        })
        expect(result).toHaveLength(1)
        return result[0].totalCost
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    // gpt-5.4 base: $2.5/Mtok input, $15/Mtok output.
    const GPT54_BASE = (100_000 * 2.5 + 1_000 * 15) / 1_000_000

    it('bills a fast row at exactly 2x its no-speed twin (platform catalog)', async () => {
      expect(await costOf('gpt-5.4', {}, 'platform')).toBeCloseTo(GPT54_BASE, 9)
      expect(await costOf('gpt-5.4', { speed: 'fast' }, 'platform')).toBeCloseTo(GPT54_BASE * 2, 9)
    })

    it('bills a slow row at exactly 0.5x its no-speed twin', async () => {
      expect(await costOf('gpt-5.4', { speed: 'slow' }, 'platform')).toBeCloseTo(GPT54_BASE * 0.5, 9)
    })

    it('bills unknown speed values at 1x (forward-compat)', async () => {
      expect(await costOf('gpt-5.4', { speed: 'turbo' }, 'platform')).toBeCloseTo(GPT54_BASE, 9)
    })

    it('applies the multiplier via the static pricing table too (no provider), across all four rates', async () => {
      // gpt-5.4 static: input 2.5, output 15, cacheCreation 2.5, cacheRead 0.25.
      const base =
        (100_000 * 2.5 + 1_000 * 15 + 10_000 * 2.5 + 50_000 * 0.25) / 1_000_000
      expect(await costOf('gpt-5.4', { cacheCreation: 10_000, cacheRead: 50_000 })).toBeCloseTo(
        base,
        9,
      )
      expect(
        await costOf('gpt-5.4', { speed: 'fast', cacheCreation: 10_000, cacheRead: 50_000 }),
      ).toBeCloseTo(base * 2, 9)
    })

    it('composes the multiplier on top of the long-context cliff rates', async () => {
      // 300K input trips the 272K cliff: gpt-5.4 reprices to $5 in / $22.5 out,
      // then the fast tier doubles the whole thing.
      const cliffed = (300_000 * 5 + 2_000 * 22.5) / 1_000_000
      expect(await costOf('gpt-5.4', { input: 300_000, output: 2_000 }, 'platform')).toBeCloseTo(
        cliffed,
        9,
      )
      expect(
        await costOf('gpt-5.4', { input: 300_000, output: 2_000, speed: 'fast' }, 'platform'),
      ).toBeCloseTo(cliffed * 2, 9)
    })

    it('bills gpt-5.5 fast at 2.5x and Opus 4.8 / Grok fast at 2x', async () => {
      const gpt55Base = (100_000 * 5 + 1_000 * 30) / 1_000_000
      expect(await costOf('gpt-5.5', { speed: 'fast' }, 'platform')).toBeCloseTo(
        gpt55Base * 2.5,
        9,
      )
      const opusBase = (100_000 * 5 + 1_000 * 25) / 1_000_000
      expect(await costOf('claude-opus-4-8', { speed: 'fast' }, 'platform')).toBeCloseTo(
        opusBase * 2,
        9,
      )
      // Anthropic serves fast mode natively, so its catalog carries the multiplier too.
      expect(await costOf('claude-opus-4-8', { speed: 'fast' }, 'anthropic')).toBeCloseTo(
        opusBase * 2,
        9,
      )
      const grokBase = (100_000 * 2 + 1_000 * 6) / 1_000_000
      expect(await costOf('grok-4.5', { speed: 'fast' }, 'platform')).toBeCloseTo(grokBase * 2, 9)
    })

    it('prefers the local computation over tier-blind costUSD when a multiplier applies', async () => {
      expect(await costOf('gpt-5.4', { speed: 'fast', costUSD: 9.99 }, 'platform')).toBeCloseTo(
        GPT54_BASE * 2,
        9,
      )
    })

    it('keeps costUSD precedence when speed is absent or the model has no multipliers', async () => {
      expect(await costOf('gpt-5.4', { costUSD: 9.99 }, 'platform')).toBeCloseTo(9.99, 9)
      // claude-sonnet-5 has no speedMultipliers → costUSD still wins even with speed set.
      expect(
        await costOf('claude-sonnet-5', { speed: 'fast', costUSD: 9.99 }, 'platform'),
      ).toBeCloseTo(9.99, 9)
    })

    it('bills a model with no speedMultipliers at 1x even for fast rows', async () => {
      // claude-sonnet-5: $3/Mtok input, $15/Mtok output, no fast tier.
      const sonnetBase = (100_000 * 3 + 1_000 * 15) / 1_000_000
      expect(await costOf('claude-sonnet-5', { speed: 'fast' }, 'platform')).toBeCloseTo(
        sonnetBase,
        9,
      )
    })
  })

  describe('loadDailyUsageData — provider catalog pricing (per-line)', () => {
    it('prices a custom catalog model via the once-built map, and 0 without a provider', async () => {
      settingsMock.mockReturnValue({
        llmProvider: 'anthropic',
        modelCatalog: {
          anthropic: {
            overrides: [
              {
                id: 'custom-priced-1',
                label: 'Custom Priced',
                supportedEfforts: ['low'],
                pricing: { inputPerMtok: 1, outputPerMtok: 2 },
              },
            ],
          },
        },
      })

      const dir = mkdtempSync(path.join(tmpdir(), 'usage-catalog-'))
      try {
        mkdirSync(path.join(dir, 'projects'), { recursive: true })
        const entry = {
          timestamp: '2026-06-20T12:00:00.000Z',
          requestId: 'req-1',
          message: {
            id: 'msg-1',
            model: 'custom-priced-1',
            usage: { input_tokens: 100_000, output_tokens: 1_000 },
          },
        }
        writeFileSync(path.join(dir, 'projects', 'session.jsonl'), `${JSON.stringify(entry)}\n`)

        // With a provider, the per-line path applies the catalog pricing.
        const withProvider = await loadDailyUsageDataLightweight({ claudePath: dir, providerId: 'anthropic' })
        expect(withProvider).toHaveLength(1)
        expect(withProvider[0].totalCost).toBeCloseTo((100_000 * 1 + 1_000 * 2) / 1_000_000, 9)
        expect(withProvider[0].modelBreakdowns[0]).toMatchObject({ modelName: 'custom-priced-1' })

        // Without a provider the custom id isn't in the static table → 0.
        const withoutProvider = await loadDailyUsageDataLightweight({ claudePath: dir })
        expect(withoutProvider[0].totalCost).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
