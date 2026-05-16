import { describe, it, expect } from 'vitest'
import {
  telegramConfigSchema,
  slackConfigSchema,
  imessageConfigSchema,
  validateChatIntegrationConfig,
  parseChatIntegrationConfig,
} from './config-schema'

// ── Telegram config schema ──────────────────────────────────────────────

describe('telegramConfigSchema', () => {
  it('accepts valid config with botToken', () => {
    const result = telegramConfigSchema.parse({ botToken: '123456:ABC-DEF' })
    expect(result.botToken).toBe('123456:ABC-DEF')
  })

  it('accepts config with optional chatId', () => {
    const result = telegramConfigSchema.parse({ botToken: '123456:ABC-DEF', chatId: '99999' })
    expect(result.chatId).toBe('99999')
  })

  it('rejects missing botToken', () => {
    expect(() => telegramConfigSchema.parse({})).toThrow()
  })

  it('rejects empty botToken', () => {
    expect(() => telegramConfigSchema.parse({ botToken: '' })).toThrow()
  })

  it('strips unknown fields', () => {
    const result = telegramConfigSchema.parse({ botToken: 'tok', extraField: 'should-be-stripped' })
    expect(result).not.toHaveProperty('extraField')
  })
})

// ── Slack config schema ─────────────────────────────────────────────────

describe('slackConfigSchema', () => {
  it('accepts valid config with both tokens', () => {
    const result = slackConfigSchema.parse({ botToken: 'xoxb-123', appToken: 'xapp-456' })
    expect(result.botToken).toBe('xoxb-123')
    expect(result.appToken).toBe('xapp-456')
  })

  it('accepts config with optional channelId', () => {
    const result = slackConfigSchema.parse({ botToken: 'xoxb-123', appToken: 'xapp-456', channelId: 'C1234' })
    expect(result.channelId).toBe('C1234')
  })

  it('rejects missing botToken', () => {
    expect(() => slackConfigSchema.parse({ appToken: 'xapp-456' })).toThrow()
  })

  it('rejects missing appToken', () => {
    expect(() => slackConfigSchema.parse({ botToken: 'xoxb-123' })).toThrow()
  })

  it('rejects empty botToken', () => {
    expect(() => slackConfigSchema.parse({ botToken: '', appToken: 'xapp-456' })).toThrow()
  })

  it('rejects empty appToken', () => {
    expect(() => slackConfigSchema.parse({ botToken: 'xoxb-123', appToken: '' })).toThrow()
  })
})

// ── iMessage config schema ──────────────────────────────────────────────

describe('imessageConfigSchema', () => {
  const validConfig = {
    gatewayUrl: 'https://gateway.example.com',
    phoneNumber: '+15551234567',
    token: 'my-secret-token',
  }

  it('accepts valid config with all fields', () => {
    const result = imessageConfigSchema.parse(validConfig)
    expect(result.gatewayUrl).toBe('https://gateway.example.com')
    expect(result.phoneNumber).toBe('+15551234567')
    expect(result.token).toBe('my-secret-token')
  })

  it('accepts valid E.164 US phone number', () => {
    const result = imessageConfigSchema.parse({ ...validConfig, phoneNumber: '+15551234567' })
    expect(result.phoneNumber).toBe('+15551234567')
  })

  it('accepts valid E.164 UK phone number', () => {
    const result = imessageConfigSchema.parse({ ...validConfig, phoneNumber: '+442071234567' })
    expect(result.phoneNumber).toBe('+442071234567')
  })

  it('accepts valid E.164 China phone number', () => {
    const result = imessageConfigSchema.parse({ ...validConfig, phoneNumber: '+8613800138000' })
    expect(result.phoneNumber).toBe('+8613800138000')
  })

  it('rejects missing phoneNumber', () => {
    const { phoneNumber: _, ...rest } = validConfig
    expect(() => imessageConfigSchema.parse(rest)).toThrow()
  })

  it('rejects empty phoneNumber', () => {
    expect(() => imessageConfigSchema.parse({ ...validConfig, phoneNumber: '' })).toThrow()
  })

  it('rejects phone without + prefix', () => {
    expect(() => imessageConfigSchema.parse({ ...validConfig, phoneNumber: '15551234567' })).toThrow()
  })

  it('rejects phone with letters', () => {
    expect(() => imessageConfigSchema.parse({ ...validConfig, phoneNumber: '+1555abc4567' })).toThrow()
  })

  it('rejects phone too short', () => {
    expect(() => imessageConfigSchema.parse({ ...validConfig, phoneNumber: '+1234' })).toThrow()
  })

  it('rejects missing gatewayUrl', () => {
    const { gatewayUrl: _, ...rest } = validConfig
    expect(() => imessageConfigSchema.parse(rest)).toThrow()
  })

  it('rejects invalid URL for gatewayUrl', () => {
    expect(() => imessageConfigSchema.parse({ ...validConfig, gatewayUrl: 'not-a-url' })).toThrow()
  })

  it('rejects missing token', () => {
    const { token: _, ...rest } = validConfig
    expect(() => imessageConfigSchema.parse(rest)).toThrow()
  })

  it('rejects empty token', () => {
    expect(() => imessageConfigSchema.parse({ ...validConfig, token: '' })).toThrow()
  })

  it('strips unknown fields', () => {
    const result = imessageConfigSchema.parse({ ...validConfig, extraField: 'should-be-stripped' })
    expect(result).not.toHaveProperty('extraField')
  })
})

// ── validateChatIntegrationConfig ───────────────────────────────────────

describe('validateChatIntegrationConfig', () => {
  it('validates telegram config', () => {
    const result = validateChatIntegrationConfig('telegram', { botToken: 'tok' })
    expect(result).toHaveProperty('botToken', 'tok')
  })

  it('validates slack config', () => {
    const result = validateChatIntegrationConfig('slack', { botToken: 'xoxb', appToken: 'xapp' })
    expect(result).toHaveProperty('botToken', 'xoxb')
    expect(result).toHaveProperty('appToken', 'xapp')
  })

  it('validates imessage config', () => {
    const result = validateChatIntegrationConfig('imessage', {
      gatewayUrl: 'https://gw.example.com',
      phoneNumber: '+15551234567',
      token: 'tok',
    })
    expect(result).toHaveProperty('gatewayUrl', 'https://gw.example.com')
    expect(result).toHaveProperty('phoneNumber', '+15551234567')
    expect(result).toHaveProperty('token', 'tok')
  })

  it('throws on invalid telegram config', () => {
    expect(() => validateChatIntegrationConfig('telegram', {})).toThrow()
  })

  it('throws on invalid slack config (missing appToken)', () => {
    expect(() => validateChatIntegrationConfig('slack', { botToken: 'xoxb' })).toThrow()
  })

  it('throws on invalid imessage config (missing token)', () => {
    expect(() => validateChatIntegrationConfig('imessage', {
      gatewayUrl: 'https://gw.example.com',
      phoneNumber: '+15551234567',
    })).toThrow()
  })

  it('throws on non-object input', () => {
    expect(() => validateChatIntegrationConfig('telegram', 'not-an-object')).toThrow()
  })

  it('throws on null input', () => {
    expect(() => validateChatIntegrationConfig('telegram', null)).toThrow()
  })
})

// ── parseChatIntegrationConfig ──────────────────────────────────────────

describe('parseChatIntegrationConfig', () => {
  it('parses valid telegram JSON', () => {
    const result = parseChatIntegrationConfig('telegram', '{"botToken":"tok"}')
    expect(result).toEqual({ botToken: 'tok' })
  })

  it('parses valid slack JSON', () => {
    const result = parseChatIntegrationConfig('slack', '{"botToken":"xoxb","appToken":"xapp"}')
    expect(result).toEqual({ botToken: 'xoxb', appToken: 'xapp' })
  })

  it('parses valid imessage JSON', () => {
    const result = parseChatIntegrationConfig(
      'imessage',
      '{"gatewayUrl":"https://gw.example.com","phoneNumber":"+15551234567","token":"tok"}',
    )
    expect(result).toEqual({
      gatewayUrl: 'https://gw.example.com',
      phoneNumber: '+15551234567',
      token: 'tok',
    })
  })

  it('returns null for corrupt JSON', () => {
    const result = parseChatIntegrationConfig('telegram', '{not-valid-json}')
    expect(result).toBeNull()
  })

  it('returns null for empty string', () => {
    const result = parseChatIntegrationConfig('telegram', '')
    expect(result).toBeNull()
  })

  it('returns null for valid JSON that fails schema validation', () => {
    const result = parseChatIntegrationConfig('slack', '{"botToken":"xoxb"}')
    expect(result).toBeNull()
  })

  it('returns null for JSON with wrong types', () => {
    const result = parseChatIntegrationConfig('telegram', '{"botToken":12345}')
    expect(result).toBeNull()
  })

  it('returns null for imessage JSON with invalid phone number', () => {
    const result = parseChatIntegrationConfig(
      'imessage',
      '{"gatewayUrl":"https://gw.example.com","phoneNumber":"not-e164","token":"tok"}',
    )
    expect(result).toBeNull()
  })
})
