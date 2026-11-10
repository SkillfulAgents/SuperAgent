import { describe, expect, it } from 'vitest'
import { freshTotpCode, normalizeBase32, parseTotpSetup, totpCode, totpMsLeft, type TotpSeed } from './totp'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 of ASCII text, without padding: the RFC 6238 test seeds are ASCII. */
function base32(text: string): string {
  let bits = ''
  for (const byte of Buffer.from(text, 'ascii')) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}

const RFC_SEEDS: Record<TotpSeed['algorithm'], string> = {
  SHA1: base32('12345678901234567890'),
  SHA256: base32('12345678901234567890123456789012'),
  SHA512: base32('1234567890123456789012345678901234567890123456789012345678901234'),
}

describe('totpCode', () => {
  // RFC 6238, Appendix B: eight digits, a 30-second period.
  it.each([
    [59, 'SHA1', '94287082'],
    [59, 'SHA256', '46119246'],
    [59, 'SHA512', '90693936'],
    [1111111109, 'SHA1', '07081804'],
    [1111111109, 'SHA256', '68084774'],
    [1111111109, 'SHA512', '25091201'],
    [1111111111, 'SHA1', '14050471'],
    [1111111111, 'SHA256', '67062674'],
    [1111111111, 'SHA512', '99943326'],
    [1234567890, 'SHA1', '89005924'],
    [1234567890, 'SHA256', '91819424'],
    [1234567890, 'SHA512', '93441116'],
    [2000000000, 'SHA1', '69279037'],
    [2000000000, 'SHA256', '90698825'],
    [2000000000, 'SHA512', '38618901'],
    [20000000000, 'SHA1', '65353130'],
    [20000000000, 'SHA256', '77737706'],
    [20000000000, 'SHA512', '47863826'],
  ] as const)('makes the RFC 6238 code at %i s with %s', (seconds, algorithm, code) => {
    expect(totpCode({ secret: RFC_SEEDS[algorithm], algorithm, digits: 8, period: 30 }, seconds * 1000)).toBe(code)
  })

  it('keeps leading zeros and takes six digits from the same value', () => {
    expect(totpCode({ secret: RFC_SEEDS.SHA1, algorithm: 'SHA1', digits: 6, period: 30 }, 1111111109 * 1000)).toBe('081804')
  })
})

describe('freshTotpCode', () => {
  const seed: TotpSeed = { secret: RFC_SEEDS.SHA1, algorithm: 'SHA1', digits: 8, period: 30 }

  it('gives the current code while enough of its period is left', async () => {
    const waits: number[] = []
    const code = await freshTotpCode(seed, () => 1111111080_000, async (ms) => { waits.push(ms) })
    expect(code).toBe(totpCode(seed, 1111111080_000))
    expect(waits).toEqual([])
  })

  it('waits for the next period when the current one is about to end', async () => {
    let now = 1111111109_000 // one second left of its period
    const waits: number[] = []
    const code = await freshTotpCode(seed, () => now, async (ms) => { waits.push(ms); now += ms })
    expect(waits).toEqual([1_200])
    expect(code).toBe(totpCode(seed, 1111111111_000))
    expect(totpMsLeft(seed, now)).toBeGreaterThan(28_000)
  })
})

describe('parseTotpSetup', () => {
  it('reads an otpauth URI with every parameter', () => {
    const setup = parseTotpSetup(`otpauth://totp/GitHub:octocat?secret=${RFC_SEEDS.SHA256}&issuer=GitHub&algorithm=SHA256&digits=8&period=60`)
    expect(setup).toEqual({
      seed: { secret: RFC_SEEDS.SHA256, algorithm: 'SHA256', digits: 8, period: 60 },
      issuer: 'GitHub',
      accountName: 'octocat',
    })
  })

  it('takes the defaults and the issuer from the label, decoded', () => {
    const setup = parseTotpSetup('otpauth://totp/Acme%20Corp:alice%40example.com?secret=jbsw%20y3dp%20ehpk%203pxp')
    expect(setup).toEqual({
      seed: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
      issuer: 'Acme Corp',
      accountName: 'alice@example.com',
    })
  })

  it('reads a bare key as sites show it to type', () => {
    expect(parseTotpSetup(' jbsw y3dp ehpk 3pxp ')?.seed).toEqual({ secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 })
    expect(parseTotpSetup('JBSW-Y3DP-EHPK-3PXP====')?.seed.secret).toBe('JBSWY3DPEHPK3PXP')
  })

  it.each([
    ['a counter-based HOTP', `otpauth://hotp/Acme:alice?secret=${RFC_SEEDS.SHA1}&counter=3`],
    ["Steam's own codes", `otpauth://totp/Steam:alice?secret=${RFC_SEEDS.SHA1}&encoder=steam`],
    ['an unknown algorithm', `otpauth://totp/Acme:alice?secret=${RFC_SEEDS.SHA1}&algorithm=MD5`],
    ['five digits', `otpauth://totp/Acme:alice?secret=${RFC_SEEDS.SHA1}&digits=5`],
    ['no secret', 'otpauth://totp/Acme:alice?issuer=Acme'],
    ['a key too short to be one', 'JBSWY3DP'],
    ['a word that is not base32', 'password1'],
    ['another URL', 'https://example.com/?secret=JBSWY3DPEHPK3PXP'],
  ])('refuses %s', (_, text) => {
    expect(parseTotpSetup(text)).toBeNull()
  })
})

describe('normalizeBase32', () => {
  it('drops spaces, hyphens and padding, and upper-cases', () => {
    expect(normalizeBase32('ab cd-ef==')).toBe('ABCDEF')
    expect(normalizeBase32('ab1c')).toBeNull()
  })
})
