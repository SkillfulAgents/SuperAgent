import { previewKind } from '@renderer/lib/file-types'
import { bashDef } from './definition'
import { identifyServiceCall } from './service-call'

/** What a media generation call's command and printed output prove, field by field. */
export interface MediaCall {
  model?: string
  prompt?: string
  status: PredictionStatus
  error?: string
  /** Links the job printed as its output. They expire within the hour. */
  outputUrls: string[]
}

export type PredictionStatus = 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'aborted'

export type MediaKind = 'image' | 'video' | 'audio'

const STATUSES = new Set<string>(['starting', 'processing', 'succeeded', 'failed', 'canceled', 'aborted'])

// Create and poll. Listing models or reading a schema makes no media, so those keep the terminal.
const PREDICTION_PATH = /\/v1\/replicate\/(?:models\/([\w.-]+\/[\w.-]+)\/predictions|predictions\/["']?[\w$-])/g

/** Which preview a link or path gets, or null when the card cannot draw it. */
export function mediaKind(pathOrUrl: string): MediaKind | null {
  const kind = previewKind(pathOrUrl.split(/[?#]/)[0])
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : null
}

/** Whether a Bash command creates or polls a media generation prediction. */
export function isPredictionCall(command: string): boolean {
  const call = identifyServiceCall(command)
  return call?.kind === 'built-in' && call.service === 'replicate' && command.search(PREDICTION_PATH) >= 0
}

function isStatus(value: unknown): value is PredictionStatus {
  return typeof value === 'string' && STATUSES.has(value)
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

export function isUnsuccessfulPrediction(status: PredictionStatus): boolean {
  return status === 'failed' || status === 'canceled' || status === 'aborted'
}

// Use the terminal when a file-only card would discard part of the result.
function collectOutputUrls(output: unknown, urls: Set<string>): boolean {
  if (output == null) return true
  if (Array.isArray(output)) return output.every((item) => collectOutputUrls(item, urls))
  if (isObject(output)) return Object.values(output).every((item) => collectOutputUrls(item, urls))
  if (typeof output !== 'string' || !/^https?:\/\/\S+$/i.test(output) || !URL.canParse(output)) return false
  urls.add(output)
  return true
}

// Older single curl creates printed no input. A compound command can print a
// different prediction from the one its first URL or prompt describes.
function directCreate(command: string): Pick<MediaCall, 'model' | 'prompt'> | undefined {
  const line = command.replace(/\\\r?\n/g, ' ').trim()
  const data = /\s(?:-d|--data|--data-raw|--data-binary|--json)\s+'([^']*)'$/.exec(line)
  const curl = data ? line.slice(0, data.index) : line
  if (!/^curl\s/.test(curl) || /[;&|`()\r\n]/.test(curl)) return undefined
  const [endpoint, another] = curl.matchAll(PREDICTION_PATH)
  if (!endpoint?.[1] || another) return undefined
  return { model: endpoint[1], prompt: data ? inputPrompt(parseJson(data[1])) : undefined }
}

function inputPrompt(value: unknown): string | undefined {
  if (isObject(value) && isObject(value.input) && typeof value.input.prompt === 'string') return value.input.prompt
  return undefined
}

/**
 * What the call proves, read from the last JSON line it printed, the line the guide's run command
 * ends with. Null when that line is not a prediction (an error reply, or nothing printed), or when
 * the job's output is text, which the terminal shows.
 */
export function parseMediaCall(command: string, result: string): MediaCall | null {
  const records = result.split('\n').map((line) => parseJson(line.trim())).filter(isObject)
  const last = records.at(-1)
  if (!last || !isStatus(last.status)) return null
  const status = last.status
  const outputUrls = new Set<string>()
  if (!collectOutputUrls(last.output, outputUrls) && !isUnsuccessfulPrediction(status)) return null
  const create = records.length === 1 ? directCreate(command) : undefined
  const model = typeof last.model === 'string' ? last.model : create?.model
  const prompt = inputPrompt(last) ?? (create?.model === model ? create?.prompt : undefined)
  return {
    model,
    prompt,
    status,
    error: isUnsuccessfulPrediction(status) && typeof last.error === 'string' ? last.error : undefined,
    outputUrls: [...outputUrls],
  }
}

/**
 * What a finished Bash call proves, from its input and result. A call that exited with an error
 * shows only a job whose prediction reached an unsuccessful terminal state.
 */
export function mediaCallOf(input: unknown, result: string | null | undefined, isError?: boolean): MediaCall | null {
  const { command } = bashDef.parseInput(input)
  const call = typeof command === 'string' && result ? parseMediaCall(command, result) : null
  return call && (!isError || isUnsuccessfulPrediction(call.status)) ? call : null
}
