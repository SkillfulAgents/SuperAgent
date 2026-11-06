import { previewKind } from '@renderer/lib/file-types'
import { bashDef } from './definition'
import { identifyServiceCall } from './service-call'

/** What a media generation call's command and printed output prove, field by field. */
export interface MediaCall {
  model?: string
  prompt?: string
  status?: PredictionStatus
  error?: string
  /** Links the job printed as its output. They expire within the hour. */
  outputUrls: string[]
}

export type PredictionStatus = 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'

export type MediaKind = 'image' | 'video' | 'audio'

const STATUSES = new Set<string>(['starting', 'processing', 'succeeded', 'failed', 'canceled'])

// Create and poll. Listing models or reading a schema makes no media, so those keep the terminal.
const PREDICTION_PATH = /\/v1\/replicate\/(?:models\/([\w.-]+\/[\w.-]+)\/predictions|predictions\/["']?[\w$-])/
const PROMPT = /"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/

/** Which preview a link or path gets, or null when the card cannot draw it. */
export function mediaKind(pathOrUrl: string): MediaKind | null {
  const kind = previewKind(pathOrUrl.split(/[?#]/)[0])
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : null
}

/** Whether a Bash command creates or polls a media generation prediction. */
export function isPredictionCall(command: string): boolean {
  const call = identifyServiceCall(command)
  return call?.kind === 'built-in' && call.service === 'replicate' && PREDICTION_PATH.test(command)
}

function isStatus(value: unknown): value is PredictionStatus {
  return typeof value === 'string' && STATUSES.has(value)
}

function unescaped(json: string): string {
  const value = parseJson(`"${json}"`)
  return typeof value === 'string' ? value : json
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function urlsIn(output: unknown): string[] {
  if (typeof output === 'string') return output.startsWith('https://') ? [output] : []
  if (Array.isArray(output)) return output.flatMap(urlsIn)
  if (isObject(output)) return Object.values(output).flatMap(urlsIn)
  return []
}

/**
 * What the call proves, read from the last JSON line it printed, the line the guide's run command
 * ends with. Null when that line is not a prediction (an error reply, or nothing printed), or when
 * the job's output is text, which the terminal shows.
 */
export function parseMediaCall(command: string, result: string): MediaCall | null {
  const last = result.split('\n').map((line) => parseJson(line.trim())).filter(isObject).at(-1)
  if (!last || !isStatus(last.status)) return null
  if (typeof last.output === 'string' && last.output !== '' && !/^https?:\/\//.test(last.output)) return null
  const status = last.status
  const prompt = PROMPT.exec(command)?.[1]
  return {
    model: PREDICTION_PATH.exec(command)?.[1] ?? (typeof last.model === 'string' ? last.model : undefined),
    prompt: prompt === undefined ? undefined : unescaped(prompt),
    status,
    error: status === 'failed' && typeof last.error === 'string' ? last.error : undefined,
    outputUrls: [...new Set(urlsIn(last.output))],
  }
}

/**
 * What a finished Bash call proves, from its input and result. A call that exited with an error
 * shows only a job it proves failed or was canceled.
 */
export function mediaCallOf(input: unknown, result: string | null | undefined, isError?: boolean): MediaCall | null {
  const { command } = bashDef.parseInput(input)
  const call = typeof command === 'string' && result ? parseMediaCall(command, result) : null
  return !isError || call?.status === 'failed' || call?.status === 'canceled' ? call : null
}
