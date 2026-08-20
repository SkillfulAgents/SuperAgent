import { describe, it, expect } from 'vitest'
import { opLoginItemSchema, parseAccounts, parseFieldOutput, parseLoginItems, usernameOf } from './op-schema'

describe('opLoginItemSchema', () => {
  it('keeps an item with urls and fields', () => {
    const item = opLoginItemSchema.parse({
      id: 'abc',
      title: 'Notion',
      category: 'LOGIN',
      urls: [{ href: 'https://www.notion.so/login' }],
      fields: [{ id: 'username', value: 'jeremy@example.com' }],
    })
    expect(item.urls).toHaveLength(1)
    expect(item.fields[0].value).toBe('jeremy@example.com')
  })

  it('tolerates an item with no urls and no fields', () => {
    const item = opLoginItemSchema.parse({ id: 'x', title: 'Old thing', category: 'LOGIN' })
    expect(item.urls).toEqual([])
    expect(item.fields).toEqual([])
  })

  it('reads a list-shaped item and uses additional_information as username', () => {
    const items = parseLoginItems([{
      id: 'gh',
      title: 'GitHub',
      category: 'LOGIN',
      additional_information: 'jeremy@example.com',
      urls: [{ primary: true, href: 'https://github.com' }],
    }])
    expect(items[0].urls[0].href).toBe('https://github.com')
    expect(usernameOf(items[0])).toBe('jeremy@example.com')
  })
})

describe('parseLoginItems', () => {
  it('drops malformed entries instead of discarding the whole batch', () => {
    const items = parseLoginItems([
      { id: 'ok', title: 'Fine', category: 'LOGIN' },
      { nope: true },
    ])
    expect(items.map((i) => i.id)).toEqual(['ok'])
  })

  it('keeps the username value and drops other field values', () => {
    const items = parseLoginItems([{
      id: 'ok',
      title: 'Fine',
      category: 'LOGIN',
      fields: [
        { id: 'username', label: 'username', value: 'a@x.com' },
        { id: 'password', label: 'password', type: 'CONCEALED', value: 's3cret' },
        { id: 'otp', type: 'OTP', value: '123456' },
      ],
    }])
    expect(items[0].fields).toEqual([
      { id: 'username', label: 'username', value: 'a@x.com' },
      { id: 'password', label: 'password', type: 'CONCEALED' },
      { id: 'otp', type: 'OTP' },
    ])
  })
})

describe('parseFieldOutput', () => {
  it('parses two-field output keyed by label, preserving whitespace', () => {
    const out = parseFieldOutput([
      { id: 'username', label: 'username', value: 'jeremy@work.com' },
      { id: 'password', label: 'password', value: ' p,ass word ' },
    ])
    expect(out).toEqual({ username: 'jeremy@work.com', password: ' p,ass word ' })
  })
  it('returns empty username when the item has none', () => {
    expect(parseFieldOutput([{ id: 'password', label: 'password', value: 'x' }]))
      .toEqual({ username: '', password: 'x' })
  })
  it('returns null password when missing so callers can fail retrieval', () => {
    expect(parseFieldOutput([{ id: 'username', label: 'username', value: 'a' }]).password).toBeNull()
  })
  it('rejects malformed field output', () => {
    expect(() => parseFieldOutput('not json shaped')).toThrow()
  })
})

describe('parseAccounts', () => {
  it('parses op account list output', () => {
    expect(parseAccounts([{ account_uuid: 'A1', url: 'x.1password.com' }])[0].account_uuid).toBe('A1')
  })
})
