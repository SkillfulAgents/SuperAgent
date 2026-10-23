import { describe, it, expect } from 'vitest'
import { isPredictionCall, parseMediaCall } from './media-call'

const AUTH = '-H "Authorization: Bearer $PLATFORM_AUTH_TOKEN"'
const CREATE = `curl -sS -X POST "$PLATFORM_BASE_URL/v1/replicate/models/black-forest-labs/flux-1.1-pro/predictions" ${AUTH} -H "Content-Type: application/json" -d '{"input": {"prompt": "a red fox in snow, \\"cinematic\\"", "aspect_ratio": "16:9"}}'`
const POLL = `curl -sS "$PLATFORM_BASE_URL/v1/replicate/predictions/p1" ${AUTH}`

describe('isPredictionCall', () => {
  it.each([
    ['a create', CREATE],
    ['a poll', POLL],
    ['the older base variable', `curl -s "\${ANTHROPIC_BASE_URL}/v1/replicate/predictions/abc123"`],
    ['an id in a variable', 'curl -sS "$PLATFORM_BASE_URL/v1/replicate/predictions/$ID"'],
  ])('matches %s', (_case, command) => {
    expect(isPredictionCall(command)).toBe(true)
  })

  it('leaves listing, schema and other services to the plain service row', () => {
    expect(isPredictionCall(`curl -sS "$PLATFORM_BASE_URL/v1/replicate/models?kind=image" ${AUTH}`)).toBe(false)
    expect(isPredictionCall(`curl -sS "$PLATFORM_BASE_URL/v1/replicate/models/google/veo-3.1" ${AUTH}`)).toBe(false)
    expect(isPredictionCall(`curl -sS "$PLATFORM_BASE_URL/v1/apollo/predictions/x" ${AUTH}`)).toBe(false)
  })
})

describe('parseMediaCall', () => {
  it('reads what the guide run command prints, with model and prompt from the command', () => {
    const printed = 'prediction p1\n{"id":"p1","model":"black-forest-labs/flux-1.1-pro","status":"succeeded","output":["https://replicate.delivery/a/out-0.webp"]}\n-rw-r--r-- 1 agent agent 1176213 Oct 23 15:00 /workspace/fox-1-out-0.webp'
    expect(parseMediaCall(CREATE, printed)).toEqual({
      model: 'black-forest-labs/flux-1.1-pro',
      prompt: 'a red fox in snow, "cinematic"',
      status: 'succeeded',
      error: undefined,
      outputUrls: ['https://replicate.delivery/a/out-0.webp'],
    })
  })

  it('reads output links from a string, a list or an object', () => {
    expect(parseMediaCall(POLL, '{"status":"succeeded","output":{"image":"https://replicate.delivery/a/o.png"}}')?.outputUrls).toEqual(['https://replicate.delivery/a/o.png'])
    expect(parseMediaCall(POLL, '{"status":"succeeded","output":"https://replicate.delivery/a/o.mp4"}')?.outputUrls).toEqual(['https://replicate.delivery/a/o.mp4'])
  })

  it('shows a failed job with its error, and ignores words in the prompt', () => {
    const call = parseMediaCall(POLL, 'prediction p1\n{"status":"failed","input":{"prompt":"status: succeeded"},"error":"NSFW content detected","output":null}')
    expect(call).toMatchObject({ status: 'failed', error: 'NSFW content detected' })
  })

  it('keeps the terminal for an error reply, text output, or nothing printed', () => {
    expect(parseMediaCall(CREATE, '{"type":"error","error":{"type":"permission_error","message":"denied"}}')).toBeNull()
    expect(parseMediaCall(POLL, '{"status":"succeeded","output":"The quick brown fox"}')).toBeNull()
    expect(parseMediaCall(POLL, 'status=succeeded file=/workspace/fox.png')).toBeNull()
    expect(parseMediaCall(POLL, '')).toBeNull()
  })
})
