import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  it('routes the guide’s run and foreground completion poll to the media card', () => {
    const guide = readFileSync(resolve(__dirname, '../../../../../agent-container/docs/media-generation.md'), 'utf8')
    const commands = [...guide.matchAll(/^`{3}bash\n([\s\S]*?)\n`{3}$/gm)]
      .map(([, command]) => command.replaceAll('{owner}/{name}', 'google/imagen-4'))
    expect(commands.map(isPredictionCall)).toEqual([false, false, true, true])
  })
})

describe('parseMediaCall', () => {
  it('keeps the command metadata for an older, unambiguous create', () => {
    const printed = 'prediction p1\n{"id":"p1","model":"black-forest-labs/flux-1.1-pro","status":"succeeded","output":["https://replicate.delivery/a/out-0.webp"]}\n-rw-r--r-- 1 agent agent 1176213 Oct 23 15:00 /workspace/fox-1-out-0.webp'
    expect(parseMediaCall(CREATE, printed)).toEqual({
      model: 'black-forest-labs/flux-1.1-pro',
      prompt: 'a red fox in snow, "cinematic"',
      status: 'succeeded',
      error: undefined,
      outputUrls: ['https://replicate.delivery/a/out-0.webp'],
    })
  })

  it('takes the model, prompt and output from the same printed prediction', () => {
    const first = JSON.stringify({ id: 'p1', model: 'owner/first', input: { prompt: 'first' }, status: 'starting' })
    const second = { id: 'p2', model: 'owner/second', input: { prompt: 'second' }, status: 'succeeded', output: 'https://replicate.delivery/2.png' }
    const combined = CREATE + '\n' + POLL
    for (const command of [POLL, combined]) {
      expect(parseMediaCall(command, first + '\n' + JSON.stringify(second))).toMatchObject({
        model: 'owner/second', prompt: 'second', outputUrls: [second.output],
      })
    }
    const withoutMetadata = '{"status":"succeeded","output":"https://replicate.delivery/2.png"}'
    expect(parseMediaCall(combined, withoutMetadata)).toMatchObject({ model: undefined, prompt: undefined })
    expect(parseMediaCall(CREATE, '{"model":"other/model","status":"processing"}')?.prompt).toBeUndefined()
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
