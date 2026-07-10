import { z } from 'zod'

// Classification of SDK `result` messages. Two error shapes exist on the wire:
//
//   legacy:  { subtype: 'error' | 'error_during_execution', error/message: '…' }
//   modern:  { subtype: 'success', is_error: true, terminal_reason: 'api_error',
//              api_error_status: 404, result: '<human-readable explanation>' }
//
// The modern shape (observed on claude-agent-sdk 0.3.206, see the
// sdk206-error-turn-invalid-model fixture) is invisible to a subtype-only
// check — the turn would be classified as a success and no session_error
// emitted. terminal_reason is present on every result (success turns carry
// 'completed'); only the values below indicate a dead turn.

const ERROR_TERMINAL_REASONS = new Set([
  'api_error',
  'budget_exhausted',
  'malformed_tool_use_exhausted',
  'structured_output_retry_exhausted',
  'tool_deferred_unavailable',
  'turn_setup_failed',
])

// A deliberate stop, not a failure: the SDK reports a gracefully-interrupted
// turn as an error-shaped result (is_error: true, subtype
// error_during_execution) with one of these reasons. Surfacing that as a
// session_error would show the user an error card for their own Stop click.
const INTERRUPT_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools'])

// The stream is open-world: unknown subtypes and future terminal_reason values
// must pass through untouched, and a malformed field must degrade to "absent",
// never throw. Hence every field optional + .catch(undefined).
const resultFieldsSchema = z.object({
  subtype: z.string().optional().catch(undefined),
  is_error: z.boolean().optional().catch(undefined),
  terminal_reason: z.string().optional().catch(undefined),
  api_error_status: z.number().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  result: z.string().optional().catch(undefined),
  fatal: z.boolean().optional().catch(undefined),
})

export interface ResultClassification {
  isError: boolean
  /** True for a deliberately stopped turn (user Stop / harness abort) — settle quietly, no error surface. */
  isInterrupt: boolean
  /** Human-readable error text; null when the turn succeeded. */
  errorText: string | null
  /** Raw terminal_reason when present (success turns carry 'completed'). */
  terminalReason: string | null
  /** HTTP status of the failed API call, when the SDK reported one. */
  apiErrorStatus: number | null
  fatal: boolean
}

export function classifyResult(content: unknown): ResultClassification {
  const parsed = resultFieldsSchema.safeParse(content)
  const f = parsed.success ? parsed.data : {}

  const isInterrupt = f.terminal_reason !== undefined && INTERRUPT_TERMINAL_REASONS.has(f.terminal_reason)

  const isError =
    !isInterrupt &&
    (f.subtype === 'error' ||
      f.subtype === 'error_during_execution' ||
      f.is_error === true ||
      (f.terminal_reason !== undefined && ERROR_TERMINAL_REASONS.has(f.terminal_reason)))

  // `result` carries the model-facing explanation in the modern error shape;
  // `error`/`message` are the legacy carriers and take precedence when set so
  // existing container-synthesized errors keep their copy.
  const errorText = isError ? f.error || f.message || f.result || 'An error occurred during execution' : null

  return {
    isError,
    isInterrupt,
    errorText,
    terminalReason: f.terminal_reason ?? null,
    apiErrorStatus: f.api_error_status ?? null,
    fatal: f.fatal === true,
  }
}
