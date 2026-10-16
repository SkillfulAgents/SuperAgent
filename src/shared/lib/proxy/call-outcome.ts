import { POLICY_DECISION_LABELS } from '@shared/lib/types/request-log'
import { FAILURE_POLICY_DECISIONS } from '@shared/lib/services/activity-aggregation'
import type { TransformedItem, TransformedMessage } from '@shared/lib/utils/message-transform'

export interface ProxyCallRecord {
  statusCode: number | null
  errorMessage: string | null
  policyDecision: string | null
}

export interface ProxyCallOutcome {
  requests: number
  failed: number
  error?: string
}

const REFUSALS = new Set<string>(FAILURE_POLICY_DECISIONS)

const STATUS_WORDS = new Map([
  [400, 'Bad request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not found'],
  [409, 'Conflict'],
  [422, 'Invalid request'],
  [429, 'Rate limited'],
])

// The forward path logs `Upstream returned N` (api/routes/proxy.ts), which a status word replaces.
const UPSTREAM_STATUS = /^Upstream returned \d+$/

function failureOf(record: ProxyCallRecord): string | null {
  if (record.policyDecision && REFUSALS.has(record.policyDecision)) return POLICY_DECISION_LABELS[record.policyDecision]
  const message = record.errorMessage?.trim()
  if (message && !UPSTREAM_STATUS.test(message)) return message
  const status = record.statusCode
  if (status !== null && status >= 400) return STATUS_WORDS.get(status) ?? (status >= 500 ? 'Service error' : `Error ${status}`)
  return null
}

export function summarizeCallOutcome(records: ProxyCallRecord[]): ProxyCallOutcome | null {
  const last = records.at(-1)
  if (!last) return null
  const error = failureOf(last)
  return {
    requests: records.length,
    failed: records.filter((r) => failureOf(r) !== null).length,
    ...(error && { error }),
  }
}

// Clock skew between the container that timestamps the transcript and the host that stamps requests.
const SKEW_MS = 60_000

type ToolCall = TransformedMessage['toolCalls'][number]

// A background call returns before its requests do.
function canHaveOutcome(toolCall: ToolCall): toolCall is ToolCall & { resultAt: Date } {
  return toolCall.name === 'Bash' && !!toolCall.resultAt && !toolCall.input.run_in_background && !toolCall.backgroundTaskId
}

export function taggedCallIds(items: TransformedItem[]): string[] {
  return items.flatMap((item) => (item.type === 'assistant' ? item.toolCalls.filter(canHaveOutcome).map((c) => c.id) : []))
}

// A request counts only until the call's result: an address the agent saved keeps stamping later requests with an old call's id.
export function attachCallOutcomes(items: TransformedItem[], records: Array<ProxyCallRecord & { toolUseId: string | null; createdAt: Date }>): void {
  const byCall = new Map<string, typeof records>()
  for (const record of records) {
    if (!record.toolUseId) continue
    const calls = byCall.get(record.toolUseId)
    if (calls) calls.push(record)
    else byCall.set(record.toolUseId, [record])
  }
  for (const item of items) {
    if (item.type !== 'assistant') continue
    for (const toolCall of item.toolCalls.filter(canHaveOutcome)) {
      const until = toolCall.resultAt.getTime() + SKEW_MS
      const outcome = summarizeCallOutcome((byCall.get(toolCall.id) ?? []).filter((r) => r.createdAt.getTime() <= until))
      if (outcome) toolCall.proxyOutcome = outcome
    }
  }
}
