import { beforeEach, describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, promises as fsPromises } from 'fs'
import { tmpdir } from 'os'

const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import {
  loadDailyUsageData as loadDailyUsageDataLightweight,
  loadSessionUsageTotals,
  calculateCost,
} from './usage-service'

import { LocalFileOps } from '@shared/lib/agent-actor/local-file-ops'

const FIXTURES_DIR = path.resolve(__dirname, '__fixtures__/usage-data')

/** A fixture's Claude directory as a workspace: the usage loaders read through file operations. */
function dailyOptions(claudePath: string) {
  return { files: new LocalFileOps(() => claudePath), dir: 'projects' }
}

/** One transcript by host path, as the workspace it sits in plus its name. */
function sessionOptions(sessionPath: string) {
  return { files: new LocalFileOps(() => path.dirname(sessionPath)), transcript: path.basename(sessionPath) }
}
const RUNTIME_MODEL_FIXTURE = path.join(FIXTURES_DIR, 'runtime-model-ids')
const MISSING_PRICE_FIXTURE = path.join(FIXTURES_DIR, 'missing-model-price')

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
          loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) }),
        ])

        const normalizedCcusage = normalize(ccusageResult as DailyResult[])
        const normalizedLightweight = normalize(lightweightResult)

        expect(normalizedLightweight.length).toBe(normalizedCcusage.length)

        for (let i = 0; i < normalizedCcusage.length; i++) {
          const cc = normalizedCcusage[i]
          const lw = normalizedLightweight[i]

          expect(lw.date).toBe(cc.date)
          expect(lw.inputTokens).toBe(cc.inputTokens)
          // This pinned ccusage version keeps the first duplicate snapshot.
          // We keep the richest total-token snapshot, so output/cost can be higher.
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

      const allData = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })
      const filteredData = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath), since: '20251206' })

      expect(allData.length).toBeGreaterThanOrEqual(2)
      expect(filteredData.length).toBe(1)
      expect(filteredData[0].date).toBe('2025-12-06')
    })

    it('since filter matches ccusage output', async () => {
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')
      const since = '20251205'

      const [ccusageResult, lightweightResult] = await Promise.all([
        loadWithCcusage(claudePath, since),
        loadDailyUsageDataLightweight({ ...dailyOptions(claudePath), since }),
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
        ...dailyOptions('/tmp/nonexistent-usage-test-path'),
      })
      expect(result).toEqual([])
    })
  })

  describe('loadDailyUsageData — deduplication', () => {
    it('produces consistent results (idempotent dedup)', async () => {
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')
      const result1 = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })
      const result2 = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })
      expect(normalize(result1)).toEqual(normalize(result2))
    })
  })

  describe('loadDailyUsageData — subagent files', () => {
    it('includes usage from subagent (agent-*) files', async () => {
      // Agent 4b41 has agent-*.jsonl files alongside regular session files
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })

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

  describe('loadSessionUsageTotals', () => {
    it('calculates totals from only the requested session transcript', async () => {
      const claudePath = getClaudePath('edge-cases')
      const sessionPath = path.join(claudePath, 'projects', '-workspace', 'session-a.jsonl')

      const [totals, allDaily] = await Promise.all([
        loadSessionUsageTotals({ ...sessionOptions(sessionPath) }),
        loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) }),
      ])
      const sessionDay = allDaily.find((day) => day.date === '2025-12-10')!

      expect(totals).toEqual({
        totalCost: sessionDay.totalCost,
        totalTokens:
          sessionDay.inputTokens +
          sessionDay.outputTokens +
          sessionDay.cacheCreationTokens +
          sessionDay.cacheReadTokens,
        priceMissing: sessionDay.priceMissing,
        // session-a also contains a deliberately malformed trailing row.
        usageIncomplete: true,
      })
    })

    it('returns zero totals before a session transcript exists', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-missing-session-'))
      writeFileSync(path.join(dir, 'agent-legacy.jsonl'), '{}\n')

      try {
        const totals = await loadSessionUsageTotals({
          ...sessionOptions(path.join(dir, 'missing-session.jsonl')),
        })

        expect(totals).toEqual({
          totalCost: 0,
          totalTokens: 0,
          priceMissing: false,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('deduplicates snapshots when requestId presence differs', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-mixed-request-id-'))
      const transcript = path.join(dir, 'mixed-request-id.jsonl')
      const partialSnapshot = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T12:00:00.000Z',
        requestId: 'request-1',
        costUSD: 0.1,
        message: {
          id: 'shared-message-id',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      })
      const finalSnapshotWithoutRequestId = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T12:00:01.000Z',
        costUSD: 0.2,
        message: {
          id: 'shared-message-id',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      })
      writeFileSync(transcript, `${partialSnapshot}\n${finalSnapshotWithoutRequestId}\n`)

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: (100 * 3 + 20 * 15) / 1_000_000,
          totalTokens: 120,
          priceMissing: false,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('sanitized runtime-model regression fixture', () => {
    const sessionPath = path.join(
      RUNTIME_MODEL_FIXTURE,
      'projects',
      '-workspace',
      'sanitized-session.jsonl',
    )

    it('deduplicates repeated snapshots that omit requestId', async () => {
      const result = await loadDailyUsageDataLightweight({
        ...dailyOptions(RUNTIME_MODEL_FIXTURE),

      })
      const day = result.find((entry) => entry.date === '2026-01-01')!

      // The source transcript had three identical snapshots for the first
      // message and no requestId. Count that message once: 138,263 tokens,
      // rather than the previously displayed 229,419.
      expect(day.inputTokens).toBe(5_939)
      expect(day.outputTokens).toBe(354)
      expect(day.cacheCreationTokens).toBe(85_916)
      expect(day.cacheReadTokens).toBe(46_054)
      expect(
        day.inputTokens +
          day.outputTokens +
          day.cacheCreationTokens +
          day.cacheReadTokens,
      ).toBe(138_263)
      expect(day.totalCost).toBeCloseTo(0.2394188, 10)
      expect(day.modelBreakdowns).toEqual([
        expect.objectContaining({
          modelName: 'anthropic/claude-sonnet-5-20260630',
          cost: 0.2394188,
        }),
      ])
    })

    it('prices each provider-qualified dated model id retained in the fixture', async () => {
      const result = await loadDailyUsageDataLightweight({
        ...dailyOptions(RUNTIME_MODEL_FIXTURE),

      })
      const day = result.find((entry) => entry.date === '2026-01-02')!
      const costs = new Map(day.modelBreakdowns.map((entry) => [entry.modelName, entry.cost]))

      expect(costs.get('anthropic/claude-4.6-opus-20260205')).toBeCloseTo(0.19845875, 10)
      expect(costs.get('anthropic/claude-4.6-sonnet-20260217')).toBeCloseTo(0.1221165, 10)
      expect(costs.get('openai/gpt-5.5-20260423')).toBeCloseTo(0.12104, 10)
      expect(costs.get('x-ai/grok-4.5-20260708')).toBeCloseTo(0.0553124, 10)
      expect(costs.get('anthropic/claude-4.5-haiku-20251001')).toBeCloseTo(0.04190125, 10)
      expect(day.totalCost).toBeCloseTo(0.5388289, 10)
    })

    it('returns corrected all-time totals through the session calculation path', async () => {
      await expect(
        loadSessionUsageTotals({ ...sessionOptions(sessionPath) }),
      ).resolves.toEqual({
        totalCost: 0.7782477,
        totalTokens: 286_966,
        priceMissing: false,
        usageIncomplete: false,
      })
    })
  })

  describe('sanitized missing-model-price regression fixture', () => {
    const sessionPath = path.join(
      MISSING_PRICE_FIXTURE,
      'projects',
      '-workspace',
      'sanitized-session.jsonl',
    )

    it('marks an unpriced discovered model without changing its deduplicated tokens', async () => {
      await expect(loadSessionUsageTotals({ ...sessionOptions(sessionPath) })).resolves.toEqual({
        totalCost: 0,
        totalTokens: 79_429,
        priceMissing: true,
        usageIncomplete: false,
      })
    })

    it('marks unknown pricing as missing even when the SDK records zero', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-recorded-zero-'))
      const transcript = path.join(dir, 'recorded-zero.jsonl')
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T12:00:00.000Z',
          costUSD: 0,
          message: {
            id: 'recorded-zero-message',
            model: 'unknown-but-recorded-free',
            usage: { input_tokens: 100, output_tokens: 10 },
          },
        })}\n`,
      )

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0,
          totalTokens: 110,
          priceMissing: true,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('session usage completeness', () => {
    it('counts both cache-read-only and cache-creation-only usage rows', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-cache-only-'))
      const transcript = path.join(dir, 'cache-only.jsonl')
      const cacheReadRow = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T12:00:00.000Z',
        message: {
          id: 'cache-only-message',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 123,
          },
        },
      })
      const cacheCreationRow = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T12:00:01.000Z',
        costUSD: 0,
        message: {
          id: 'cache-creation-only-message',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 456,
            cache_read_input_tokens: 0,
          },
        },
      })
      writeFileSync(transcript, `${cacheReadRow}\n${cacheCreationRow}\n`)

      try {
        const totals = await loadSessionUsageTotals({ ...sessionOptions(transcript) })
        expect(totals).toEqual({
          totalCost: (123 * 0.3 + 456 * 3.75) / 1_000_000,
          totalTokens: 579,
          priceMissing: false,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('warns rather than guessing ownership of legacy flat subagent transcripts', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-legacy-subagent-'))
      const transcript = path.join(dir, 'session.jsonl')
      const legacySubagent = path.join(dir, 'agent-legacy.jsonl')
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T12:00:00.000Z',
          costUSD: 0.1,
          message: {
            id: 'main-session-message',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 10 },
          },
        })}\n`,
      )
      writeFileSync(
        legacySubagent,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T12:00:01.000Z',
          costUSD: 0.2,
          message: {
            id: 'unlinked-subagent-message',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 200, output_tokens: 20 },
          },
        })}\n`,
      )

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0.00045,
          totalTokens: 110,
          priceMissing: false,
          usageIncomplete: true,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('warns while retaining valid totals when a JSONL row is truncated', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-truncated-'))
      const transcript = path.join(dir, 'truncated.jsonl')
      const validRow = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T12:00:00.000Z',
        message: {
          id: 'valid-message',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      })
      writeFileSync(transcript, `${validRow}\n{"message":{"usage":{"input_tokens":50}\n`)

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0.00045,
          totalTokens: 110,
          priceMissing: false,
          usageIncomplete: true,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('warns when a discovered transcript cannot be read', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-unreadable-'))
      const transcript = path.join(dir, 'unreadable.jsonl')
      writeFileSync(transcript, '{}\n')
      const openSpy = vi
        .spyOn(fsPromises, 'open')
        .mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }))

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0,
          totalTokens: 0,
          priceMissing: false,
          usageIncomplete: true,
        })
      } finally {
        openSpy.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('loadDailyUsageData — line splitting', () => {
    // Transcripts are scanned as raw bytes and only usage-bearing lines are
    // decoded, so line boundaries have to survive stream chunking without a
    // string decoder in front of them. The stream reads 64KiB at a time.
    const CHUNK_SIZE = 64 * 1024

    function usageRow(overrides: { id: string; padding?: string; note?: string }) {
      return JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T12:00:00.000Z',
        padding: overrides.padding,
        note: overrides.note,
        message: {
          id: overrides.id,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      })
    }

    it('reassembles rows that span stream chunk boundaries', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-chunk-spanning-'))
      const transcript = path.join(dir, 'session.jsonl')
      // Each row is wider than a chunk, so every row is reassembled from
      // several chunks and no boundary lands on a newline.
      const rows = ['a', 'b', 'c'].map((id) =>
        usageRow({ id, padding: 'x'.repeat(CHUNK_SIZE + 137) }),
      )
      writeFileSync(transcript, `${rows.join('\n')}\n`)

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0.00135,
          totalTokens: 330,
          priceMissing: false,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('decodes multi-byte characters split across a chunk boundary', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-multibyte-'))
      const transcript = path.join(dir, 'session.jsonl')
      // "€" is three bytes; pad so its bytes straddle the 64KiB read boundary.
      const note = '€ mid-boundary'
      const buildRow = (paddingWidth: number) =>
        usageRow({ id: 'multibyte', padding: 'x'.repeat(paddingWidth), note })
      // Everything ahead of the note is ASCII, so one measurement is enough to
      // solve for the padding that puts the first "€" byte at CHUNK_SIZE - 1.
      const probe = buildRow(0)
      const row = buildRow(CHUNK_SIZE - 1 - probe.indexOf(note))
      expect(Buffer.from(row, 'utf-8').indexOf(Buffer.from(note, 'utf-8'))).toBe(CHUNK_SIZE - 1)
      writeFileSync(transcript, `${row}\n`)

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0.00045,
          totalTokens: 110,
          priceMissing: false,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('counts a final row written without a trailing newline', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-no-trailing-newline-'))
      const transcript = path.join(dir, 'session.jsonl')
      writeFileSync(transcript, usageRow({ id: 'last' }))

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0.00045,
          totalTokens: 110,
          priceMissing: false,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('skips blank and CRLF-terminated separator lines without flagging the load', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-blank-lines-'))
      const transcript = path.join(dir, 'session.jsonl')
      writeFileSync(transcript, `\n   \n${usageRow({ id: 'crlf' })}\r\n\r\n`)

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0.00045,
          totalTokens: 110,
          priceMissing: false,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('ignores rows whose only "_tokens" match sits outside message.usage', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-marker-decoy-'))
      const transcript = path.join(dir, 'session.jsonl')
      const decoy = JSON.stringify({
        type: 'user',
        timestamp: '2026-01-01T12:00:00.000Z',
        message: { content: 'reported "input_tokens" in the logs' },
      })
      writeFileSync(transcript, `${decoy}\n${usageRow({ id: 'real' })}\n`)

      try {
        await expect(loadSessionUsageTotals({ ...sessionOptions(transcript) })).resolves.toEqual({
          totalCost: 0.00045,
          totalTokens: 110,
          priceMissing: false,
          usageIncomplete: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('loadDailyUsageData — costUSD field', () => {
    it('computes API-equivalent costs even when entries contain costUSD', async () => {
      const claudePath = getClaudePath('bedrock-agent')
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })

      const sorted = normalize(result)

      // Two Sonnet entries: 1100 input, 250 output, 100 cache writes, 200 cache reads.
      expect(sorted[0].date).toBe('2025-12-05')
      expect(sorted[0].totalCost).toBeCloseTo((1100 * 3 + 250 * 15 + 100 * 3.75 + 200 * 0.3) / 1_000_000, 6)

      // 2025-12-06: one entry with costUSD 0.0005
      expect(sorted[1].date).toBe('2025-12-06')
      expect(sorted[1].totalCost).toBeCloseTo((300 * 1 + 50 * 5) / 1_000_000, 6)
    })

    it('preserves Bedrock model names for downstream normalization', async () => {
      const claudePath = getClaudePath('bedrock-agent')
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })

      const allModels = result.flatMap((d) => d.modelBreakdowns.map((mb) => mb.modelName))
      // Should keep the raw Bedrock model name — normalization happens in the route
      expect(allModels).toContain('us.anthropic.claude-sonnet-4-5-20250929-v1')
      expect(allModels).toContain('global.anthropic.claude-haiku-4-5-20251001')
    })

    it('aggregates cost per model breakdown', async () => {
      const claudePath = getClaudePath('bedrock-agent')
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })

      const dec5 = result.find((d) => d.date === '2025-12-05')!
      const sonnetBreakdown = dec5.modelBreakdowns.find((mb) =>
        mb.modelName === 'us.anthropic.claude-sonnet-4-5-20250929-v1'
      )!
      expect(sonnetBreakdown.cost).toBeCloseTo((1100 * 3 + 250 * 15 + 100 * 3.75 + 200 * 0.3) / 1_000_000, 6)
      expect(sonnetBreakdown.inputTokens).toBe(1100)
      expect(sonnetBreakdown.outputTokens).toBe(250)
    })
  })

  describe('loadDailyUsageData — hardcoded pricing for standard models', () => {
    it('computes non-zero costs for known Claude models', async () => {
      // Agent 4b41 uses claude-sonnet-4-5-20250929 and claude-haiku-4-5-20251001
      const claudePath = getClaudePath('4b41c573-4c33-456d-9cc5-3df6ee95dc32')
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })

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

    it('ignores provider-recorded costs when a global rate exists', async () => {
      // Bedrock fixture has costUSD; the shared rate card still determines the estimate.
      const claudePath = getClaudePath('bedrock-agent')
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(claudePath) })

      const dec5 = result.find((d) => d.date === '2025-12-05')!
      expect(dec5.totalCost).toBeCloseTo((1100 * 3 + 250 * 15 + 100 * 3.75 + 200 * 0.3) / 1_000_000, 6)
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
  })

  describe('calculateCost — Grok 200K long-context cliff', () => {
    it('bills grok-4.7 on the same card as grok-4.6', () => {
      expect(calculateCost('grok-4.7', 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * 2 + 1_000 * 6) / 1_000_000,
        9,
      )
      expect(calculateCost('grok-4.7', 250_000, 2_000, 0, 0)).toBeCloseTo(
        (250_000 * 4 + 2_000 * 12) / 1_000_000,
        9,
      )
    })

    it('bills grok-4.6 below 200k at $2 / $6', () => {
      expect(calculateCost('grok-4.6', 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * 2 + 1_000 * 6) / 1_000_000,
        9,
      )
    })

    it('reprices grok-4.6 above 200k at $4 / $12', () => {
      expect(calculateCost('grok-4.6', 250_000, 2_000, 0, 0)).toBeCloseTo(
        (250_000 * 4 + 2_000 * 12) / 1_000_000,
        9,
      )
    })

    it('reprices grok-4.5 above 200k at $4 / $12 with cache read $0.60', () => {
      expect(calculateCost('grok-4.5', 150_000, 2_000, 0, 100_000)).toBeCloseTo(
        (150_000 * 4 + 2_000 * 12 + 100_000 * 0.6) / 1_000_000,
        9,
      )
    })
  })

  describe('calculateCost — global overrides and unknown ids', () => {
    it('returns 0 for unknown models', () => {
      expect(calculateCost('totally-unknown', 100_000, 1_000, 0, 0)).toBe(0)
    })

    it('uses a global override for a built-in model', () => {
      settingsMock.mockReturnValue({
        modelPricing: { 'gpt-5.5': { inputPerMtok: 6, outputPerMtok: 36 } },
      })

      expect(calculateCost('gpt-5.5', 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * 6 + 1_000 * 36) / 1_000_000,
        9,
      )
    })

    it('uses net-new custom model pricing and returns 0 when pricing is absent', () => {
      settingsMock.mockReturnValue({
        modelPricing: { 'custom-priced-1': { inputPerMtok: 1, outputPerMtok: 2 } },
      })

      expect(calculateCost('custom-priced-1', 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * 1 + 1_000 * 2) / 1_000_000,
        9,
      )
      expect(calculateCost('custom-freeform-1', 100_000, 1_000, 0, 0)).toBe(0)
    })

    it('honors a patched custom long-context cliff', () => {
      settingsMock.mockReturnValue({
        modelPricing: { 'custom-cliff-1': { ...{ inputPerMtok: 1, outputPerMtok: 2 }, longContextPriceCliff: {
                  thresholdTokens: 100,
                  inputMultiplier: 3,
                  outputMultiplier: 4,
                } } },
      })

      expect(calculateCost('custom-cliff-1', 200, 10, 0, 0)).toBeCloseTo(
        (200 * 3 + 10 * 8) / 1_000_000,
        9,
      )
    })

    it('uses the same global override for every provider alias', () => {
      settingsMock.mockReturnValue({
        modelPricing: { 'claude-opus-4-8': { inputPerMtok: 9, outputPerMtok: 45 } },
      })

      expect(calculateCost('us.anthropic.claude-opus-4-8', 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * 9 + 1_000 * 45) / 1_000_000,
        9,
      )
      expect(calculateCost('claude-opus-4-8', 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * 9 + 1_000 * 45) / 1_000_000,
        9,
      )
    })
  })

  describe('calculateCost — runtime model id aliases', () => {
    const aliasPricingTimestamp = Date.parse('2026-08-20T12:00:00.000Z')

    it.each([
      // Anthropic API canonical ids and pre-4.6 convenience aliases.
      ['claude-sonnet-5', 2, 10],
      ['claude-haiku-4-5-20251001', 1, 5],
      ['claude-haiku-4-5', 1, 5],
      // Provider-translated runtime ids observed in sanitized transcripts.
      ['anthropic/claude-sonnet-5-20260630', 2, 10],
      ['anthropic/claude-4.6-sonnet-20260217', 3, 15],
      ['anthropic/claude-4.6-opus-20260205', 5, 25],
      ['anthropic/claude-4.5-haiku-20251001', 1, 5],
      // OpenRouter dotted Claude ids and Google Cloud @snapshot ids.
      ['anthropic/claude-sonnet-4.6', 3, 15],
      ['anthropic/claude-haiku-4.5', 1, 5],
      ['claude-haiku-4-5@20251001', 1, 5],
      // Current dateless Claude-in-Bedrock ids.
      ['anthropic.claude-opus-4-8', 5, 25],
      // OpenAI canonical ids, official snapshots, proxy snapshots, and aliases.
      ['gpt-5.5', 5, 30],
      ['gpt-5.6-sol', 5, 30],
      ['openai/gpt-5.5-20260423', 5, 30],
      ['gpt-5.5-2026-04-23', 5, 30],
      ['openai/gpt-5.5-2026-04-23', 5, 30],
      ['gpt-5.6', 5, 30],
      ['openai/gpt-5.6', 5, 30],
      // xAI canonical, provider-qualified, concrete runtime, and alias ids.
      ['grok-4.5', 2, 6],
      ['x-ai/grok-4.5', 2, 6],
      ['x-ai/grok-4.5-20260708', 2, 6],
      ['grok-4.5-latest', 2, 6],
      ['x-ai/grok-4.5-latest', 2, 6],
      ['grok-build-latest', 2, 6],
      ['x-ai/grok-build-latest', 2, 6],
      ['grok-4.6', 2, 6],
      ['x-ai/grok-4.6', 2, 6],
      ['grok-4.7', 2, 6],
      ['x-ai/grok-4.7', 2, 6],
      ['x-ai/grok-4.7-20260916', 2, 6],
    ])('prices %s through its canonical rate card', (model, inputRate, outputRate) => {
      expect(
        calculateCost(model, 100_000, 1_000, 0, 0, aliasPricingTimestamp),
      ).toBeCloseTo(
        (100_000 * inputRate + 1_000 * outputRate) / 1_000_000,
        9,
      )
    })

    it.each(['us', 'eu', 'apac', 'jp', 'au', 'global'])(
      'normalizes a %s Bedrock geographic inference-profile id',
      (geography) => {
        expect(
          calculateCost(
            `${geography}.anthropic.claude-sonnet-4-5-20250929-v1:0`,
            100_000,
            1_000,
            0,
            0,
          ),
        ).toBeCloseTo((100_000 * 3 + 1_000 * 15) / 1_000_000, 9)
      },
    )

    it.each([
      'anthropic.claude-sonnet-4-5-20250929-v1:0',
      'us.anthropic.claude-opus-4-6-v1',
    ])('normalizes the Bedrock version suffix in %s', (model) => {
      const inputRate = model.includes('opus') ? 5 : 3
      const outputRate = model.includes('opus') ? 25 : 15
      expect(calculateCost(model, 100_000, 1_000, 0, 0)).toBeCloseTo(
        (100_000 * inputRate + 1_000 * outputRate) / 1_000_000,
        9,
      )
    })

    it('does not inherit base pricing for an unmatched OpenRouter variant', () => {
      expect(calculateCost('openai/gpt-5.5:free', 100_000, 1_000, 0, 0)).toBe(0)
    })

    it('uses exact global pricing for an OpenRouter variant', () => {
      settingsMock.mockReturnValue({
        modelPricing: { 'openai/gpt-5.5:thinking': { inputPerMtok: 7, outputPerMtok: 42 } },
      })

      expect(
        calculateCost('openai/gpt-5.5:thinking', 100_000, 1_000, 0, 0),
      ).toBeCloseTo((100_000 * 7 + 1_000 * 42) / 1_000_000, 9)
    })

    it('uses exact global pricing for an arbitrary Generic/private deployment id', () => {
      settingsMock.mockReturnValue({
        modelPricing: { 'private-deployment-west': { inputPerMtok: 8, outputPerMtok: 24 } },
      })

      expect(
        calculateCost('private-deployment-west', 100_000, 1_000, 0, 0),
      ).toBeCloseTo((100_000 * 8 + 1_000 * 24) / 1_000_000, 9)
    })

    it('applies a canonical global pricing override to a dated runtime id', () => {
      settingsMock.mockReturnValue({
        modelPricing: { 'claude-sonnet-5': { inputPerMtok: 6, outputPerMtok: 36 } },
      })

      expect(
        calculateCost(
          'anthropic/claude-sonnet-5-20260630',
          100_000,
          1_000,
          0,
          0,
        ),
      ).toBeCloseTo((100_000 * 6 + 1_000 * 36) / 1_000_000, 9)
    })

    it('uses the shared built-in rate when no override is configured', () => {
      settingsMock.mockReturnValue({
        modelPricing: {  },
      })

      expect(
        calculateCost(
          'anthropic/claude-sonnet-5-20260630',
          100_000,
          1_000,
          0,
          0,
        ),
      ).toBeCloseTo((100_000 * 2 + 1_000 * 10) / 1_000_000, 9)
    })
  })

  describe('loadDailyUsageData — edge cases', () => {
    const edgePath = getClaudePath('edge-cases')

    it('skips non-usage lines (queue-operation, user messages, malformed JSON)', async () => {
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(edgePath) })
      // Should not crash — malformed lines and non-usage entries are silently skipped
      expect(result.length).toBeGreaterThan(0)
    })

    it('deduplicates entries across files and keeps the richest token snapshot', async () => {
      // msg_dup1/req_dup1 appears multiple times with output snapshots 50, 75, and 50.
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(edgePath) })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      // opus-4-6 entries: msg_dup1 (100in/75out, highest kept), msg_002 (200/100), msg_005 (400/200 costUSD=0)
      const opusBreakdown = dec10.modelBreakdowns.find((mb) => mb.modelName === 'claude-opus-4-6')!
      // 100 + 200 + 400 = 700 input (not 800 — dup was skipped)
      expect(opusBreakdown.inputTokens).toBe(700)
      // 75 + 100 + 200 = 375 output
      expect(opusBreakdown.outputTokens).toBe(375)
    })

    it('falls back to "unknown" for entries without a model field', async () => {
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(edgePath) })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      const unknownBreakdown = dec10.modelBreakdowns.find((mb) => mb.modelName === 'unknown')
      expect(unknownBreakdown).toBeDefined()
      expect(unknownBreakdown!.inputTokens).toBe(50)
      expect(unknownBreakdown!.outputTokens).toBe(25)
      // Unknown model → cost should be 0
      expect(unknownBreakdown!.cost).toBe(0)
    })

    it('returns cost 0 for unknown models', async () => {
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(edgePath) })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      const unknownModel = dec10.modelBreakdowns.find((mb) => mb.modelName === 'totally-unknown-model')
      expect(unknownModel).toBeDefined()
      expect(unknownModel!.inputTokens).toBe(300)
      expect(unknownModel!.cost).toBe(0)
    })

    it('computes API-equivalent cost for known models even when costUSD is zero', async () => {
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(edgePath) })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      // All three Opus requests use the shared $5 input / $25 output rate.
      const opusBreakdown = dec10.modelBreakdowns.find((mb) => mb.modelName === 'claude-opus-4-6')!
      expect(opusBreakdown.cost).toBeCloseTo((700 * 5 + 375 * 25) / 1_000_000, 6)
    })

    it('prices Bedrock aliases with the same shared rates', async () => {
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(edgePath) })
      const dec10 = result.find((d) => d.date === '2025-12-10')!

      // msg_006 has costUSD: 0.05 for a bedrock model
      const bedrockBreakdown = dec10.modelBreakdowns.find(
        (mb) => mb.modelName === 'us.anthropic.claude-opus-4-6-v1'
      )
      expect(bedrockBreakdown).toBeDefined()
      expect(bedrockBreakdown!.cost).toBeCloseTo((500 * 5 + 250 * 25) / 1_000_000, 6)
    })

    it('aggregates across multiple days from different files', async () => {
      const result = await loadDailyUsageDataLightweight({ ...dailyOptions(edgePath) })

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
    ): Promise<number> {
      const dir = mkdtempSync(path.join(tmpdir(), 'usage-speed-'))
      try {
        mkdirSync(path.join(dir, 'projects'), { recursive: true })
        writeFileSync(
          path.join(dir, 'projects', 'session.jsonl'),
          `${JSON.stringify(makeEntry(model, opts))}\n`,
        )
        const result = await loadDailyUsageDataLightweight({
          ...dailyOptions(dir),
        })
        expect(result).toHaveLength(1)
        return result[0].totalCost
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    // gpt-5.4 base: $2.5/Mtok input, $15/Mtok output.
    const GPT54_BASE = (100_000 * 2.5 + 1_000 * 15) / 1_000_000

    it('bills a fast row at exactly 2x its no-speed twin (shared rate card)', async () => {
      expect(await costOf('gpt-5.4', {})).toBeCloseTo(GPT54_BASE, 9)
      expect(await costOf('gpt-5.4', { speed: 'fast' })).toBeCloseTo(GPT54_BASE * 2, 9)
    })

    it('bills a slow row at exactly 0.5x its no-speed twin', async () => {
      expect(await costOf('gpt-5.4', { speed: 'slow' })).toBeCloseTo(GPT54_BASE * 0.5, 9)
    })

    it('bills unknown speed values at 1x (forward-compat)', async () => {
      expect(await costOf('gpt-5.4', { speed: 'turbo' })).toBeCloseTo(GPT54_BASE, 9)
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
      expect(await costOf('gpt-5.4', { input: 300_000, output: 2_000 })).toBeCloseTo(
        cliffed,
        9,
      )
      expect(
        await costOf('gpt-5.4', { input: 300_000, output: 2_000, speed: 'fast' }),
      ).toBeCloseTo(cliffed * 2, 9)
    })

    it('bills gpt-5.5 fast at 2.5x and Opus 4.8 / Grok fast at 2x', async () => {
      const gpt55Base = (100_000 * 5 + 1_000 * 30) / 1_000_000
      expect(await costOf('gpt-5.5', { speed: 'fast' })).toBeCloseTo(
        gpt55Base * 2.5,
        9,
      )
      const opusBase = (100_000 * 5 + 1_000 * 25) / 1_000_000
      expect(await costOf('claude-opus-4-8', { speed: 'fast' })).toBeCloseTo(
        opusBase * 2,
        9,
      )
      // Anthropic serves fast mode natively, so its catalog carries the multiplier too.
      expect(await costOf('claude-opus-4-8', { speed: 'fast' })).toBeCloseTo(
        opusBase * 2,
        9,
      )
      const grokBase = (100_000 * 2 + 1_000 * 6) / 1_000_000
      expect(await costOf('grok-4.5', { speed: 'fast' })).toBeCloseTo(grokBase * 2, 9)
      expect(await costOf('grok-4.6', { speed: 'fast' })).toBeCloseTo(grokBase * 2, 9)
      expect(await costOf('grok-4.7', { speed: 'fast' })).toBeCloseTo(grokBase * 2, 9)
    })

    it('bills claude-opus-5-5 at its cut 4/20 card, doubled in fast mode', async () => {
      const opus55Base = (100_000 * 4 + 1_000 * 20) / 1_000_000
      expect(await costOf('claude-opus-5-5', {})).toBeCloseTo(opus55Base, 9)
      expect(await costOf('claude-opus-5-5', { speed: 'fast' })).toBeCloseTo(opus55Base * 2, 9)
      expect(calculateCost('claude-opus-5-5', 0, 0, 100_000, 100_000)).toBeCloseTo(
        (100_000 * 5 + 100_000 * 0.2) / 1_000_000,
        9,
      )
    })

    it('bills kimi-k3 on the Fireworks fast router at 1.5x', async () => {
      const kimiBase = (100_000 * 3 + 1_000 * 15) / 1_000_000
      expect(await costOf('kimi-k3', {})).toBeCloseTo(kimiBase, 9)
      expect(await costOf('kimi-k3', { speed: 'fast' })).toBeCloseTo(kimiBase * 1.5, 9)
      // No slow tier on Fireworks — an unmapped tier bills standard.
      expect(await costOf('kimi-k3', { speed: 'slow' })).toBeCloseTo(kimiBase, 9)
    })

    it('bills platform GLM-5.3 Flash at Cloudflare list rates with no speed tier', async () => {
      const glmBase = (100_000 * 0.15 + 1_000 * 0.5) / 1_000_000
      expect(await costOf('glm-5.3-flash', {})).toBeCloseTo(glmBase, 9)
      expect(await costOf('glm-5.3-flash', { speed: 'fast' })).toBeCloseTo(glmBase, 9)
    })

    it('bills platform DeepSeek V4.1 Flash at Fireworks list rates with no speed tier', async () => {
      const deepseekBase = (100_000 * 0.22 + 1_000 * 0.66) / 1_000_000
      expect(await costOf('deepseek-v4.1-flash', {})).toBeCloseTo(deepseekBase, 9)
      expect(await costOf('deepseek-v4.1-flash', { speed: 'fast' })).toBeCloseTo(
        deepseekBase,
        9,
      )
    })

    it('prefers the local computation over tier-blind costUSD when a multiplier applies', async () => {
      expect(await costOf('gpt-5.4', { speed: 'fast', costUSD: 9.99 })).toBeCloseTo(
        GPT54_BASE * 2,
        9,
      )
    })

    it('ignores recorded costs with or without a speed multiplier', async () => {
      expect(await costOf('gpt-5.4', { costUSD: 9.99 })).toBeCloseTo(GPT54_BASE, 9)
      // Sonnet has no speed multiplier; it uses the standard shared rate.
      expect(
        await costOf('claude-sonnet-5', { speed: 'fast', costUSD: 9.99 }),
      ).toBeCloseTo((100_000 * 2 + 1_000 * 10) / 1_000_000, 9)
    })

    it('bills a model with no speedMultipliers at 1x even for fast rows', async () => {
      // Sonnet 5's launch pricing is now its permanent standard rate.
      const sonnetBase = (100_000 * 2 + 1_000 * 10) / 1_000_000
      expect(await costOf('claude-sonnet-5', { speed: 'fast' })).toBeCloseTo(
        sonnetBase,
        9,
      )
    })
  })

  describe('loadDailyUsageData — global model pricing (per-line)', () => {
    it('recalculates existing transcripts when the global custom price changes', async () => {
      settingsMock.mockReturnValue({
        llmProvider: 'anthropic',
        modelPricing: { 'custom-priced-1': { inputPerMtok: 1, outputPerMtok: 2 } },
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

        // The per-line path applies the shared custom rate.
        const initial = await loadDailyUsageDataLightweight({ ...dailyOptions(dir) })
        expect(initial).toHaveLength(1)
        expect(initial[0].totalCost).toBeCloseTo((100_000 * 1 + 1_000 * 2) / 1_000_000, 9)
        expect(initial[0].modelBreakdowns[0]).toMatchObject({ modelName: 'custom-priced-1' })

        // Editing the global price also updates estimates for existing transcripts.
        settingsMock.mockReturnValue({ modelPricing: { 'custom-priced-1': { inputPerMtok: 2, outputPerMtok: 4 } } })
        const updated = await loadDailyUsageDataLightweight({ ...dailyOptions(dir) })
        expect(updated[0].totalCost).toBeCloseTo((100_000 * 2 + 1_000 * 4) / 1_000_000, 9)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('prices dated runtime ids from the custom model, and a foreign-prefixed deployment from its own key', async () => {
      settingsMock.mockReturnValue({
        modelPricing: {
          'qwen/qwen3-max': { inputPerMtok: 1, outputPerMtok: 2 },
          'gpt-5.5': { inputPerMtok: 50, outputPerMtok: 300 },
          'azure/gpt-5.5': { inputPerMtok: 4, outputPerMtok: 8 },
        },
      })

      const dir = mkdtempSync(path.join(tmpdir(), 'usage-global-keys-'))
      try {
        mkdirSync(path.join(dir, 'projects'), { recursive: true })
        const models = ['qwen/qwen3-max-20260101', 'azure/gpt-5.5-20260423', 'openai/gpt-5.5']
        const lines = models.map((model, index) =>
          JSON.stringify({
            timestamp: '2026-06-20T12:00:00.000Z',
            requestId: `req-${index}`,
            message: { id: `msg-${index}`, model, usage: { input_tokens: 100_000, output_tokens: 1_000 } },
          }),
        )
        writeFileSync(path.join(dir, 'projects', 'session.jsonl'), `${lines.join('\n')}\n`)

        const [day] = await loadDailyUsageDataLightweight({ ...dailyOptions(dir) })
        const costs = new Map(day.modelBreakdowns.map((entry) => [entry.modelName, entry.cost]))
        const cost = (input: number, output: number) => (100_000 * input + 1_000 * output) / 1_000_000
        expect(costs.get('qwen/qwen3-max-20260101')).toBeCloseTo(cost(1, 2), 9)
        expect(costs.get('azure/gpt-5.5-20260423')).toBeCloseTo(cost(4, 8), 9)
        expect(costs.get('openai/gpt-5.5')).toBeCloseTo(cost(50, 300), 9)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
