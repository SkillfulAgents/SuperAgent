/**
 * The main agent's response as it streams: the text so far, the tool call
 * being written, an open thinking block, and the turn-level states the
 * activity label reflects (compacting, retrying). Fed by the SDK's stream
 * events; complete messages are the transcript's business, not this one's.
 */
import type { SessionUsage } from '@shared/lib/types/agent'
import { makeThinkingBlockId } from '@shared/lib/utils/thinking-block-id'
import { redactStreamedToolInput } from './redaction'
import type { SessionEvent } from './session-channel'

export interface MainStreamSink {
  emit(event: SessionEvent): void
  /** A new response started: the reply context the outcome falls back on starts over. */
  responseStarted(): void
  /** Reply text streamed. */
  textStreamed(text: string): void
}

/** A tool call the agent finished writing. */
export interface FinishedToolUse {
  id: string
  name: string
  /** The input as JSON text. */
  input: string
}

type StreamEvent = {
  type: string
  index?: number
  message?: { id?: string; model?: string }
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type: string; text?: string; partial_json?: string; thinking?: string }
  usage?: TokenUsage
}

export type TokenUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** A context nobody has measured yet: a window of 0 shows as no percentage. */
const UNMEASURED: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  contextWindow: 0,
}

export class MainStream {
  /** Text streamed in the current message; cleared once the message is complete. */
  currentText = ''
  /** Reply text owns the surface (set at the first text token, not at message start). */
  isStreaming = false
  currentToolUse: { id: string; name: string } | null = null
  currentToolInput = ''
  isThinking = false
  isCompacting = false
  isRetrying = false
  // The SDK message id and content index of the open thinking block: the
  // live block's id matches the persisted one.
  private messageId: string | null = null
  private thinkingBlockIndex: number | null = null
  /** The model the latest API call ran on: its usage is read against that model's window. */
  model: string | undefined = undefined
  /** The latest single API call's usage: the context's size as of then. */
  lastUsage: SessionUsage | null = null

  /**
   * `contextWindowFor` is the session's answer for a model's window. A
   * window it does not know yet goes out as 0 rather than as a guess.
   */
  constructor(
    private readonly sink: MainStreamSink,
    private readonly contextWindowFor: (model: string | undefined) => number | undefined,
  ) {}

  /** One stream event. Returns the tool call it finished, for the session to act on. */
  event(event: StreamEvent): FinishedToolUse | null {
    switch (event.type) {
      case 'message_start':
        this.currentText = ''
        // Streaming starts at the first text token, so a message that opens
        // with a tool call stays 'working' rather than flipping streaming→working.
        this.isStreaming = false
        this.currentToolUse = null
        this.isThinking = false
        this.messageId = event.message?.id ?? null
        this.thinkingBlockIndex = null
        if (event.message?.model) this.model = event.message.model
        // The response is flowing, so any retry resolved.
        this.isRetrying = false
        this.sink.responseStarted()
        this.sink.emit({ type: 'stream_start' })
        return null

      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          this.currentToolUse = { id: event.content_block.id!, name: event.content_block.name! }
          this.currentToolInput = ''
          this.sink.emit({
            type: 'tool_use_start',
            toolId: event.content_block.id,
            toolName: event.content_block.name,
            partialInput: '',
          })
        } else if (event.content_block?.type === 'thinking') {
          // Reasoning text follows as thinking_delta (the agent asks for
          // `display: 'summarized'`; without it newer models omit the text).
          this.isThinking = true
          this.thinkingBlockIndex = Number.isInteger(event.index) ? event.index! : null
          this.sink.emit({ type: 'thinking_start', thinkingId: this.thinkingId() })
        }
        return null

      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          this.currentText += event.delta.text
          this.sink.textStreamed(event.delta.text)
          this.sink.emit({ type: 'stream_delta', text: event.delta.text })
          this.isStreaming = true
        } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          // A reconnect can miss content_block_start but keep message_start:
          // take the block index from the delta when it has one.
          if (Number.isInteger(event.index)) this.thinkingBlockIndex = event.index!
          this.sink.emit({ type: 'thinking_delta', thinkingId: this.thinkingId(), text: event.delta.thinking })
        } else if (event.delta?.type === 'input_json_delta') {
          this.currentToolInput += event.delta.partial_json || ''
          this.sink.emit({
            type: 'tool_use_streaming',
            toolId: this.currentToolUse?.id,
            toolName: this.currentToolUse?.name,
            partialInput: redactStreamedToolInput(this.currentToolUse?.name, this.currentToolInput),
          })
        }
        return null

      case 'content_block_stop':
        if (this.isThinking) this.endThinking()
        return this.currentToolUse
          ? { id: this.currentToolUse.id, name: this.currentToolUse.name, input: this.currentToolInput }
          : null

      case 'message_delta':
        // Final usage arrives here too (OpenRouter sends input_tokens: 0 in
        // message_start and the real numbers in message_delta).
        if (event.usage && (event.usage.input_tokens || event.usage.output_tokens)) this.reportUsage(event.usage)
        return null

      case 'message_stop':
        this.isStreaming = false
        this.currentToolUse = null
        this.currentToolInput = ''
        // A thinking block whose stop was missed ends with its message.
        if (this.isThinking) this.endThinking()
        this.messageId = null
        this.thinkingBlockIndex = null
        return null

      default:
        return null
    }
  }

  /** The finished tool call has been acted on: its card stops streaming. */
  toolUseReady(): void {
    if (!this.currentToolUse) return
    this.sink.emit({ type: 'tool_use_ready', toolId: this.currentToolUse.id, toolName: this.currentToolUse.name })
    this.currentToolUse = null
    this.currentToolInput = ''
  }

  /** The SDK started compacting (its status, or a boundary with no status before it). */
  compactionStarted(): void {
    if (this.isCompacting) return
    this.isCompacting = true
    this.sink.emit({ type: 'compact_start' })
  }

  /**
   * The compaction summary arrived: clients swap the spinner for the boundary
   * and refetch. The latest call measured the context the summary replaced,
   * so the size is unmeasured until the next call reports it.
   */
  compactionEnded(): void {
    this.isCompacting = false
    this.lastUsage = null
    this.sink.emit({ type: 'context_usage', ...UNMEASURED })
    this.sink.emit({ type: 'compact_complete' })
    this.sink.emit({ type: 'messages_updated' })
  }

  /** The SDK is retrying an API request. */
  retrying(content: { attempt?: unknown; max_retries?: unknown; delay_ms?: unknown; error_status?: unknown }): void {
    this.isRetrying = true
    this.sink.emit({
      type: 'api_retry',
      attempt: content.attempt,
      maxRetries: content.max_retries,
      delayMs: content.delay_ms,
      errorStatus: content.error_status,
    })
  }

  /** One API call's usage, and the model it ran on when the frame names it: the context's current size. */
  reportUsage(usage: TokenUsage, model?: string): void {
    if (model) this.model = model
    this.lastUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      contextWindow: this.contextWindowFor(this.model) ?? 0,
      ...(this.model ? { model: this.model } : {}),
    }
    this.sink.emit({ type: 'context_usage', ...this.lastUsage })
  }

  /**
   * The turn's result: the latest call's usage goes out again, against the
   * window the session knows now (the result can be what taught it), and is
   * returned for the session to persist. (Not the result's own usage, which
   * sums every call in the turn.)
   */
  settleUsage(): SessionUsage | null {
    if (!this.lastUsage) return null
    this.lastUsage = { ...this.lastUsage, contextWindow: this.contextWindowFor(this.lastUsage.model) ?? 0 }
    this.sink.emit({ type: 'context_usage', ...this.lastUsage })
    return this.lastUsage
  }

  /** A complete assistant message landed: its streamed text is now in the transcript. */
  messagePersisted(): void {
    this.currentText = ''
  }

  /**
   * A new turn. A turn that ended mid-compaction, mid-thinking or mid-retry
   * (an error or a stop before the clearing event) must not carry that label
   * into the next one.
   */
  newTurn(): void {
    this.isCompacting = false
    this.isThinking = false
    this.messageId = null
    this.thinkingBlockIndex = null
    this.isRetrying = false
  }

  /** The turn stopped: nothing is streaming any more. */
  stop(): void {
    this.isStreaming = false
    this.currentText = ''
    this.currentToolUse = null
    this.currentToolInput = ''
  }

  private endThinking(): void {
    this.isThinking = false
    this.sink.emit({ type: 'thinking_stop', thinkingId: this.thinkingId() })
    this.thinkingBlockIndex = null
  }

  private thinkingId(): string | undefined {
    return makeThinkingBlockId(this.messageId, this.thinkingBlockIndex)
  }
}
