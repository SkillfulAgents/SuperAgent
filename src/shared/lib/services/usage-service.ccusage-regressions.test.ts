import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import { calculateCost, loadDailyUsageData, loadSessionUsageTotals } from './usage-service'

type JsonlEntry = Record<string, unknown>

async function withTranscript<T>(
  entries: JsonlEntry[],
  run: (paths: { claudePath: string; sessionPath: string }) => Promise<T>,
): Promise<T> {
  const claudePath = mkdtempSync(path.join(tmpdir(), 'ccusage-regression-'))
  const projectPath = path.join(claudePath, 'projects', 'audit-project')
  const sessionPath = path.join(projectPath, 'session.jsonl')
  mkdirSync(projectPath, { recursive: true })
  writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)

  try {
    return await run({ claudePath, sessionPath })
  } finally {
    rmSync(claudePath, { recursive: true, force: true })
  }
}

function assistantEntry(options: {
  id: string
  requestId?: string
  model?: string
  timestamp?: string
  usage: Record<string, unknown>
  costUSD?: number
  isSidechain?: boolean
}): JsonlEntry {
  return {
    type: 'assistant',
    timestamp: options.timestamp ?? '2026-08-20T12:00:00.000Z',
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    ...(options.costUSD !== undefined ? { costUSD: options.costUSD } : {}),
    ...(options.isSidechain !== undefined ? { isSidechain: options.isSidechain } : {}),
    message: {
      id: options.id,
      model: options.model ?? 'claude-sonnet-4-6',
      usage: options.usage,
    },
  }
}

describe('CCUsage post-v15.2 calculation regressions', () => {
  beforeEach(() => {
    settingsMock.mockReturnValue({ llmProvider: 'anthropic' })
  })

  it('uses the richer total-usage snapshot when output token counts tie (ccusage #984)', async () => {
    const entries = [
      assistantEntry({
        id: 'msg-partial',
        requestId: 'req-partial',
        costUSD: 0.02,
        usage: { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 0 },
      }),
      assistantEntry({
        id: 'msg-partial',
        requestId: 'req-partial',
        costUSD: 0.01,
        usage: { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 1_000 },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(loadSessionUsageTotals({ sessionPath })).resolves.toMatchObject({
        totalTokens: 1_101,
        totalCost: 0.01,
      })
    })
  })

  it('uses reported cost as the tie-breaker when token snapshots are otherwise identical', async () => {
    const entries = [
      assistantEntry({
        id: 'msg-cost-tie',
        requestId: 'req-cost-tie',
        costUSD: 0.01,
        usage: { input_tokens: 1, output_tokens: 100 },
      }),
      assistantEntry({
        id: 'msg-cost-tie',
        requestId: 'req-cost-tie',
        costUSD: 0.02,
        usage: { input_tokens: 1, output_tokens: 100 },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(loadSessionUsageTotals({ sessionPath })).resolves.toMatchObject({
        totalTokens: 101,
        totalCost: 0.02,
      })
    })
  })

  it('retains distinct non-sidechain request IDs that reuse a message ID (ccusage #984/#985)', async () => {
    const entries = [
      assistantEntry({
        id: 'msg-reused',
        requestId: 'req-a',
        costUSD: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      assistantEntry({
        id: 'msg-reused',
        requestId: 'req-b',
        costUSD: 0.02,
        usage: { input_tokens: 20, output_tokens: 6 },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(loadSessionUsageTotals({ sessionPath })).resolves.toMatchObject({
        totalTokens: 41,
        totalCost: 0.03,
      })
    })
  })

  const mixedRequestOrders = [
    ['missing → req-a → req-b', ['missing', 'req-a', 'req-b']],
    ['missing → req-b → req-a', ['missing', 'req-b', 'req-a']],
    ['req-a → missing → req-b', ['req-a', 'missing', 'req-b']],
    ['req-a → req-b → missing', ['req-a', 'req-b', 'missing']],
    ['req-b → missing → req-a', ['req-b', 'missing', 'req-a']],
    ['req-b → req-a → missing', ['req-b', 'req-a', 'missing']],
  ] as const

  it.each(mixedRequestOrders)(
    'reconciles a requestless duplicate deterministically: %s',
    async (_label, order) => {
      const entriesByKey: Record<(typeof order)[number], JsonlEntry> = {
        missing: assistantEntry({
          id: 'msg-mixed-request-ids',
          costUSD: 0.03,
          // Structurally this is req-b's snapshot, but with richer billing
          // metadata. Pair by token identity before applying the cost tie-break.
          usage: { input_tokens: 20, output_tokens: 6 },
        }),
        'req-a': assistantEntry({
          id: 'msg-mixed-request-ids',
          requestId: 'req-a',
          costUSD: 0.01,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        'req-b': assistantEntry({
          id: 'msg-mixed-request-ids',
          requestId: 'req-b',
          costUSD: 0.02,
          usage: { input_tokens: 20, output_tokens: 6 },
        }),
      }

      await withTranscript(
        order.map((key) => entriesByKey[key]),
        async ({ sessionPath }) => {
          await expect(loadSessionUsageTotals({ sessionPath })).resolves.toMatchObject({
            totalTokens: 41,
            totalCost: 0.04,
          })
        },
      )
    },
  )

  it.each([
    ['replay before parent', ['replay', 'parent']],
    ['parent before replay', ['parent', 'replay']],
  ] as const)(
    'prefers a parent over its /btw replay but retains a genuine sidechain answer: %s (ccusage #913)',
    async (_label, order) => {
      const entriesByKey = {
        replay: assistantEntry({
          id: 'msg-parent',
          requestId: 'req-sidechain-replay',
          isSidechain: true,
          usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 50_000 },
        }),
        parent: assistantEntry({
          id: 'msg-parent',
          requestId: 'req-parent',
          isSidechain: false,
          usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 20 },
        }),
      }
      const entries = [
        ...order.map((key) => entriesByKey[key]),
        assistantEntry({
          id: 'msg-parent',
          requestId: 'req-parent',
          isSidechain: false,
          usage: { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 5 },
        }),
        assistantEntry({
          id: 'msg-genuine-sidechain-answer',
          requestId: 'req-genuine-sidechain-answer',
          isSidechain: true,
          usage: { input_tokens: 0, output_tokens: 30, cache_read_input_tokens: 700 },
        }),
      ]

      await withTranscript(entries, async ({ sessionPath }) => {
        await expect(loadSessionUsageTotals({ sessionPath })).resolves.toMatchObject({
          totalTokens: 760,
          totalCost: 0.000816,
        })
      })
    },
  )

  it('uses nested cache durations and bills 1h writes at 2x input (ccusage #1221)', async () => {
    const entries = [
      assistantEntry({
        id: 'msg-cache-duration',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          // Deliberate sentinel from the upstream regression: nested duration
          // buckets are authoritative when present, rather than this flat total.
          cache_creation_input_tokens: 999,
          cache_read_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 10,
            ephemeral_1h_input_tokens: 20,
          },
        },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(loadSessionUsageTotals({ sessionPath })).resolves.toMatchObject({
        totalTokens: 60,
        totalCost: 0.0001665,
      })
    })
  })

  it('counts advisor_message iterations under the advisor model (ccusage #1423)', async () => {
    const entries = [
      assistantEntry({
        id: 'msg-advisor',
        requestId: 'req-advisor',
        model: 'claude-sonnet-4-20250514',
        timestamp: '2026-05-22T12:00:00.000Z',
        costUSD: 1.23,
        usage: {
          input_tokens: 2,
          output_tokens: 491,
          cache_creation_input_tokens: 7_853,
          cache_read_input_tokens: 226_584,
          iterations: [
            {
              type: 'message',
              input_tokens: 1,
              output_tokens: 45,
              cache_creation_input_tokens: 7_192,
              cache_read_input_tokens: 109_696,
            },
            {
              type: 'advisor_message',
              model: 'claude-opus-4-20250514',
              input_tokens: 159_419,
              output_tokens: 7_805,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            {
              type: 'message',
              input_tokens: 1,
              output_tokens: 446,
              cache_creation_input_tokens: 661,
              cache_read_input_tokens: 116_888,
            },
          ],
        },
      }),
    ]

    await withTranscript(entries, async ({ claudePath }) => {
      const [day] = await loadDailyUsageData({ claudePath })
      expect(day).toMatchObject({
        inputTokens: 159_421,
        outputTokens: 8_296,
        totalCost: 4.20666,
      })
      expect(day.modelBreakdowns.map(({ modelName }) => modelName).sort()).toEqual([
        'claude-opus-4-20250514',
        'claude-sonnet-4-20250514',
      ])
    })
  })

  it('applies the historical 6x fast-mode multiplier to Opus 4.6 (ccusage #886)', async () => {
    const entries = [
      assistantEntry({
        id: 'msg-fast',
        model: 'claude-opus-4-6',
        usage: { input_tokens: 1_000, output_tokens: 500, speed: 'fast' },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(
        loadSessionUsageTotals({ sessionPath, providerId: 'anthropic' }),
      ).resolves.toMatchObject({
        totalCost: 0.105,
      })
    })
  })

  it('applies marginal >200K rates to historical Claude 1M-context usage (ccusage #651)', () => {
    const expected =
      (200_000 * 3 + 100_000 * 6 +
        200_000 * 15 + 50_000 * 22.5 +
        200_000 * 3.75 + 100_000 * 7.5 +
        200_000 * 0.3 + 50_000 * 0.6) /
      1_000_000

    expect(
      calculateCost('claude-4-sonnet-20250514', 300_000, 250_000, 300_000, 250_000),
    ).toBeCloseTo(expected, 9)
  })

  it('applies marginal >200K rates independently to nested 1h cache writes', async () => {
    const entries = [
      assistantEntry({
        id: 'msg-marginal-1h-cache',
        model: 'claude-4-sonnet-20250514',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 300_000,
          },
        },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(
        loadSessionUsageTotals({ sessionPath, providerId: 'anthropic' }),
      ).resolves.toMatchObject({
        totalTokens: 300_000,
        // 200K at $6/M plus the remaining 100K at $12/M.
        totalCost: 2.4,
      })
    })
  })

  it('counts cache writes when selecting a whole-request long-context tier (ccusage #1541)', () => {
    // 10K fresh + 191K cache writes is above Grok's 200K prompt threshold.
    expect(calculateCost('grok-4.5', 10_000, 1_000, 191_000, 0)).toBeCloseTo(
      (10_000 * 4 + 1_000 * 12 + 191_000 * 4) / 1_000_000,
      9,
    )
  })

  it('counts nested 1h cache writes in a whole-request context cliff and prices the 1h bucket', async () => {
    const entries = [
      assistantEntry({
        id: 'msg-whole-request-1h-cache',
        model: 'grok-4.5',
        usage: {
          input_tokens: 10_000,
          output_tokens: 1_000,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 191_000,
          },
        },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(
        loadSessionUsageTotals({ sessionPath, providerId: 'platform' }),
      ).resolves.toMatchObject({
        totalTokens: 202_000,
        // All buckets use Grok's >200K tier; a 1h write is 2x the $4/M input rate.
        totalCost: 1.58,
      })
    })
  })

  it('inherits the canonical cache-write ratio for a Bedrock-prefixed Claude ID (#743 class)', () => {
    expect(
      calculateCost('us.anthropic.claude-sonnet-4-6', 0, 0, 1_000_000, 0, 'bedrock'),
    ).toBeCloseTo(3.75, 9)
  })

  it('does not bill GLM cache creation at its input-token rate (ccusage #1235)', () => {
    expect(calculateCost('z-ai/glm-5.2', 1_000_000, 0, 0, 0, 'openrouter')).toBe(1.2)
    expect(calculateCost('z-ai/glm-5.2', 0, 0, 1_000_000, 0, 'openrouter')).toBe(0)
  })

  it.each([
    {
      label: 'a launch-period row',
      timestamp: '2026-08-20T12:00:00.000Z',
    },
    {
      label: 'a later row',
      timestamp: '2027-01-01T00:00:00.000Z',
    },
  ])(
    'uses permanent Sonnet 5 $2/$10 engine and cache rates for $label',
    async ({ timestamp }) => {
      const entries = [
        assistantEntry({
          id: `msg-sonnet-5-${timestamp}`,
          model: 'claude-sonnet-5',
          timestamp,
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_creation: {
              ephemeral_5m_input_tokens: 1_000_000,
              ephemeral_1h_input_tokens: 1_000_000,
            },
          },
        }),
      ]

      await withTranscript(entries, async ({ sessionPath }) => {
        await expect(
          loadSessionUsageTotals({ sessionPath, providerId: 'anthropic' }),
        ).resolves.toMatchObject({
          totalTokens: 5_000_000,
          // $2 input + $10 output + $2.50 5m write + $4 1h write + $0.20 read.
          totalCost: 18.7,
        })
      })
    },
  )

  it('selects synthetic effective-dated rates by row timestamp when a process spans a cutoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    const frozenPreCutoffCatalogModel = {
      id: 'synthetic-effective-dated-model',
      pricing: {
        inputPerMtok: 2,
        outputPerMtok: 10,
        cacheCreationPerMtok: 2.5,
        cacheCreation1hPerMtok: 4,
        cacheReadPerMtok: 0.2,
      },
    }

    try {
      vi.setSystemTime(new Date('2029-12-31T12:00:00.000Z'))
      vi.resetModules()
      vi.doMock('../llm-provider', () => ({
        getProviderCatalog: () => [frozenPreCutoffCatalogModel],
        getEffectiveCatalog: () => [frozenPreCutoffCatalogModel],
      }))
      vi.doMock('./model-pricing.json', () => ({
        default: {
          'synthetic-effective-dated-model': {
            input: 4,
            output: 20,
            cacheCreation: 5,
            cacheCreation1h: 8,
            cacheRead: 0.4,
            historicalRates: [
              {
                before: '2030-01-01T00:00:00.000Z',
                input: 2,
                output: 10,
                cacheCreation: 2.5,
                cacheCreation1h: 4,
                cacheRead: 0.2,
              },
            ],
          },
        },
      }))

      const { loadSessionUsageTotals: loadEffectiveDated } = await import('./usage-service')
      const usage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      }

      await withTranscript(
        [
          assistantEntry({
            id: 'msg-synthetic-before-cutoff',
            model: 'synthetic-effective-dated-model',
            timestamp: '2029-12-31T23:59:59.000Z',
            usage,
          }),
        ],
        async ({ sessionPath }) => {
          await expect(
            loadEffectiveDated({ sessionPath, providerId: 'anthropic' }),
          ).resolves.toMatchObject({
            totalTokens: 5_000_000,
            totalCost: 18.7,
          })
        },
      )

      vi.setSystemTime(new Date('2030-01-01T00:00:01.000Z'))
      await withTranscript(
        [
          assistantEntry({
            id: 'msg-synthetic-after-cutoff',
            model: 'synthetic-effective-dated-model',
            timestamp: '2030-01-01T00:00:01.000Z',
            usage,
          }),
        ],
        async ({ sessionPath }) => {
          await expect(
            loadEffectiveDated({ sessionPath, providerId: 'anthropic' }),
          ).resolves.toMatchObject({
            totalTokens: 5_000_000,
            totalCost: 37.4,
          })
        },
      )
    } finally {
      vi.doUnmock('../llm-provider')
      vi.doUnmock('./model-pricing.json')
      vi.useRealTimers()
      vi.resetModules()
    }
  })

  it.each([
    { label: 'standard', speed: undefined, expectedCost: 46.75 },
    { label: 'fast', speed: 'fast', expectedCost: 93.5 },
  ])('uses Opus 5 $label pricing for engine and cache buckets', async ({ speed, expectedCost }) => {
    const entries = [
      assistantEntry({
        id: `msg-opus-5-${speed ?? 'standard'}`,
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation: {
            ephemeral_5m_input_tokens: 1_000_000,
            ephemeral_1h_input_tokens: 1_000_000,
          },
          ...(speed !== undefined ? { speed } : {}),
        },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(
        loadSessionUsageTotals({ sessionPath, providerId: 'anthropic' }),
      ).resolves.toMatchObject({
        totalTokens: 5_000_000,
        totalCost: expectedCost,
      })
    })
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s token counts and marks usage incomplete', async (_label, invalidTokens) => {
    const entries = [
      assistantEntry({
        id: `msg-invalid-token-${invalidTokens}`,
        requestId: `req-invalid-token-${invalidTokens}`,
        usage: { input_tokens: invalidTokens, output_tokens: 0 },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(loadSessionUsageTotals({ sessionPath })).resolves.toMatchObject({
        totalTokens: 0,
        totalCost: 0,
        priceMissing: false,
        usageIncomplete: true,
      })
    })
  })

  it.each([
    ['message ID', { id: '', requestId: 'req-valid' }],
    ['request ID', { id: 'msg-valid', requestId: '' }],
    ['model ID', { id: 'msg-valid', requestId: 'req-valid', model: '' }],
  ])('rejects an explicitly empty %s', async (_label, ids) => {
    const entries = [
      assistantEntry({
        ...ids,
        costUSD: 0.01,
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    ]

    await withTranscript(entries, async ({ sessionPath }) => {
      await expect(loadSessionUsageTotals({ sessionPath })).resolves.toMatchObject({
        totalTokens: 0,
        totalCost: 0,
        usageIncomplete: true,
      })
    })
  })
})
