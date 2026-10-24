import { afterEach, describe, expect, it } from 'vitest'
import {
  REDACTED,
  forgetInjectedSecrets,
  redactInjectedSecrets,
  redactInjectedSecretsDeep,
  redactToolResult,
  rememberInjectedSecret,
} from './injected-secrets'

describe('injected secret redaction', () => {
  afterEach(() => forgetInjectedSecrets())

  it('leaves output alone until a secret is injected', () => {
    expect(redactInjectedSecrets('value: hunter2-pass')).toBe('value: hunter2-pass')
  })

  it('redacts a secret as typed, URL-encoded, form-encoded and JSON-escaped', () => {
    const secret = 'S3cret! "pa ss"/é'
    rememberInjectedSecret(secret)
    const forms = [
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ v: secret }).toString().slice(2),
      encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
      JSON.stringify(secret).slice(1, -1),
    ]
    for (const form of forms) {
      expect(redactInjectedSecrets(`before ${form} after`)).toBe(`before ${REDACTED} after`)
    }
  })

  it('redacts the base64, HTML-escaped and twice JSON-escaped forms', () => {
    const secret = 'S3cret<&>"pw'
    rememberInjectedSecret(secret)
    const twice = JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1)
    for (const form of [Buffer.from(secret).toString('base64'), 'S3cret&lt;&amp;&gt;&quot;pw', twice]) {
      expect(redactInjectedSecrets(`[${form}]`)).toBe(`[${REDACTED}]`)
    }
  })

  it('redacts a value as Chromium serializes it into an attribute and a text node, also read back JSON-quoted', () => {
    const secret = `Tr0ub4dor&3'x"q<`
    rememberInjectedSecret(secret)
    for (const form of [
      `Tr0ub4dor&amp;3'x&quot;q&lt;`, // attribute, Chrome 138+ (& " < >)
      `Tr0ub4dor&amp;3'x&quot;q<`, // attribute, older Chrome (& ")
      `Tr0ub4dor&amp;3'x"q&lt;`, // text node (& < >)
      `Tr0ub4dor&amp;3&#x27;x&quot;q&lt;`,
      JSON.stringify(`Tr0ub4dor&amp;3'x&quot;q<`).slice(1, -1),
    ]) {
      expect(redactInjectedSecrets(`<input value="${form}">`)).toBe(`<input value="${REDACTED}">`)
    }
  })

  it('redacts the JSON form with HTML-safe escapes', () => {
    rememberInjectedSecret('pass&word<1>')
    expect(redactInjectedSecrets('{"password":"pass\\u0026word\\u003c1\\u003e"}')).toBe(`{"password":"${REDACTED}"}`)
  })

  it('redacts a value base64-encoded inside a longer string, at any alignment', () => {
    const secret = 'hunter2-pass!'
    rememberInjectedSecret(secret)
    for (const prefix of ['', 'a', 'ab', 'abc', 'user:', 'octocat:']) {
      const encoded = Buffer.from(`${prefix}${secret}&remember=1`).toString('base64')
      expect(redactInjectedSecrets(`Authorization: Basic ${encoded}`)).toContain(REDACTED)
    }
    // Other base64 data is untouched.
    const unrelated = Buffer.from('a different value altogether').toString('base64')
    expect(redactInjectedSecrets(unrelated)).toBe(unrelated)
  })

  it('redacts the head of a value an output cap cut short, right before the cap\'s notice', () => {
    rememberInjectedSecret('Tr0ub4dor&3xq')
    expect(redactInjectedSecrets('value: Tr0ub4d\n…[output truncated — showing 50000 of 61234 chars]'))
      .toBe(`value: ${REDACTED}\n…[output truncated — showing 50000 of 61234 chars]`)
    // Away from a cut, a fragment is just text.
    expect(redactInjectedSecrets('Tr0ub4d is not the value')).toBe('Tr0ub4d is not the value')
    // A head shorter than the minimum is left alone.
    expect(redactInjectedSecrets('Tr0\n…[truncated — result was 9 chars]')).toBe('Tr0\n…[truncated — result was 9 chars]')
  })

  it('redacts a code only where no other digit adjoins it, and never inside a ref', () => {
    rememberInjectedSecret('4829')
    expect(redactInjectedSecrets('Your code 4829 expired')).toBe(`Your code ${REDACTED} expired`)
    expect(redactInjectedSecrets('"docStart":1729482917.3,"hash":4829001')).toBe('"docStart":1729482917.3,"hash":4829001')
    expect(redactInjectedSecrets('textbox "Name" [ref=e4829] @e4829')).toBe('textbox "Name" [ref=e4829] @e4829')
    expect(redactInjectedSecrets('code=4829&next=1')).toBe(`code=${REDACTED}&next=1`)
  })

  it('redacts the text of a tool result and leaves images alone', () => {
    rememberInjectedSecret('hunter2-pass')
    const image = { type: 'image', data: 'aHVudGVyMi1wYXNz', mimeType: 'image/png' }
    const result = redactToolResult({ content: [{ type: 'text', text: 'value: hunter2-pass' }, image], isError: false })
    expect(result).toEqual({ content: [{ type: 'text', text: `value: ${REDACTED}` }, image], isError: false })
  })

  it('keeps the strings it is told to whole, and redacts the value everywhere else', () => {
    rememberInjectedSecret('acme')
    const result = redactToolResult({ content: [{ type: 'text', text: 'account jane@acme.com; workspace acme; acme.com' }] }, ['jane@acme.com', 'acme.com'])
    expect(result.content[0].text).toBe(`account jane@acme.com; workspace ${REDACTED}; acme.com`)
    // Nothing to keep: as before.
    expect(redactToolResult({ content: [{ type: 'text', text: 'jane@acme.com' }] }).content[0].text).toBe(`jane@${REDACTED}.com`)
  })

  it('redacts every occurrence, and the longest match first', () => {
    rememberInjectedSecret('abcd')
    rememberInjectedSecret('abcdefgh')
    expect(redactInjectedSecrets('abcdefgh and abcd and abcd')).toBe(`${REDACTED} and ${REDACTED} and ${REDACTED}`)
  })

  it('ignores values too short to redact without mangling page text', () => {
    rememberInjectedSecret('123')
    expect(redactInjectedSecrets('page 123 of 456')).toBe('page 123 of 456')
  })

  it('forgets everything when the browser closes', () => {
    rememberInjectedSecret('one-time-482913')
    forgetInjectedSecrets()
    expect(redactInjectedSecrets('one-time-482913')).toBe('one-time-482913')
  })

  it('redacts strings inside a captured HAR without breaking its structure', () => {
    const secret = 'pa"ss,word'
    rememberInjectedSecret(secret)
    const har = {
      log: {
        entries: [{
          request: { postData: { text: `{"password":${JSON.stringify(secret)}}`, params: [{ name: 'pw', value: secret }] } },
          time: 12,
        }],
      },
    }
    const redacted = redactInjectedSecretsDeep(har)
    expect(JSON.stringify(redacted)).not.toContain('ss,word')
    expect(redacted.log.entries[0].request.postData.params[0]).toEqual({ name: 'pw', value: REDACTED })
    expect(redacted.log.entries[0].time).toBe(12)
  })
})
