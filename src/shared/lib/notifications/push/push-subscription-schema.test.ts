import { describe, it, expect } from 'vitest'
import {
  isAllowedPushEndpoint,
  pushSubscribeRequestSchema,
} from './push-subscription-schema'

describe('isAllowedPushEndpoint — SSRF gate', () => {
  it.each([
    'https://web.push.apple.com/QEWlEq_2kKSaP3NOb7',
    'https://sub1.push.apple.com/xyz',
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://db5p.notify.windows.com/w/?token=abc',
  ])('accepts vendor push service %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true)
  })

  it.each([
    'http://web.push.apple.com/abc', // https only
    'https://localhost:8080/steal',
    'https://127.0.0.1/steal',
    'https://192.168.1.1/router-admin',
    'https://internal-service.corp/api',
    'https://evil.example/web.push.apple.com', // host in path, not hostname
    'https://web.push.apple.com.evil.example/abc', // suffix spoof
    'ftp://web.push.apple.com/abc',
    'not-a-url',
  ])('rejects %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false)
  })
})

describe('pushSubscribeRequestSchema', () => {
  const valid = {
    subscription: {
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'k1', auth: 'k2' },
    },
    origin: 'https://host.example',
  }

  it('accepts a well-formed request', () => {
    expect(pushSubscribeRequestSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a non-push-service endpoint even when otherwise well-formed', () => {
    const result = pushSubscribeRequestSchema.safeParse({
      ...valid,
      subscription: { ...valid.subscription, endpoint: 'https://attacker.example/collect' },
    })
    expect(result.success).toBe(false)
  })
})
