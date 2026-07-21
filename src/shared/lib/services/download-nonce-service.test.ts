import { describe, expect, it } from 'vitest'

import {
  deriveMacBundlePath,
  extractNonceFromFileName,
  extractNoncesFromHdiutilPlist,
  extractNonceFromUrlText,
  extractNonceFromWhereFromsHex,
} from './download-nonce-service'

const NONCE = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4'

describe('extractNonceFromFileName', () => {
  it('finds the code in a stamped Windows installer name', () => {
    expect(extractNonceFromFileName(`Gamut-1.2.3-Setup-${NONCE}.exe`)).toBe(NONCE)
  })

  it('finds the code in a stamped DMG name', () => {
    expect(extractNonceFromFileName(`Gamut-1.2.3-arm64-${NONCE}.dmg`)).toBe(NONCE)
  })

  it('survives browser duplicate-download suffixes', () => {
    expect(extractNonceFromFileName(`Gamut-1.2.3-Setup-${NONCE} (1).exe`)).toBe(NONCE)
  })

  it('works on full paths', () => {
    expect(extractNonceFromFileName(`/Users/x/Downloads/Gamut-1.2.3-${NONCE}.dmg`)).toBe(NONCE)
  })

  it('normalizes uppercase hex', () => {
    expect(extractNonceFromFileName(`Gamut-Setup-${NONCE.toUpperCase()}.exe`)).toBe(NONCE)
  })

  it('rejects unstamped names', () => {
    expect(extractNonceFromFileName('Gamut-1.2.3-Setup.exe')).toBeNull()
    expect(extractNonceFromFileName('Gamut-1.2.3-arm64.dmg')).toBeNull()
  })

  it('rejects hex runs that are too short or embedded in longer words', () => {
    expect(extractNonceFromFileName('Gamut-deadbeef.dmg')).toBeNull()
    expect(extractNonceFromFileName(`Gamut-x${NONCE}.dmg`)).toBeNull()
  })
})

describe('extractNonceFromUrlText', () => {
  it('finds the dl query param', () => {
    expect(
      extractNonceFromUrlText(`https://updates.gamutagents.com/download/mac?dl=${NONCE}`),
    ).toBe(NONCE)
  })

  it('finds it among other params', () => {
    expect(
      extractNonceFromUrlText(`https://x.test/download/win?v=1&dl=${NONCE}&utm=y`),
    ).toBe(NONCE)
  })

  it('ignores lookalike params and invalid codes', () => {
    expect(extractNonceFromUrlText(`https://x.test/?adl=${NONCE}`)).toBeNull()
    expect(extractNonceFromUrlText('https://x.test/?dl=nothex')).toBeNull()
  })
})

describe('extractNonceFromWhereFromsHex', () => {
  it('recovers the code from real `xattr -px` output', () => {
    // Verbatim `xattr -px com.apple.metadata:kMDItemWhereFroms` output
    // (macOS 15) for a binary-plist WhereFroms of
    //   [https://updates.gamutagents.com/download/mac?dl=<NONCE>,
    //    https://platform.gamutagents.com/]
    // — uppercase hex pairs, 16 per line, trailing space before each newline.
    const realXattrOutput = [
      '62 70 6C 69 73 74 30 30 A2 01 02 5F 10 60 68 74 ',
      '74 70 73 3A 2F 2F 75 70 64 61 74 65 73 2E 67 61 ',
      '6D 75 74 61 67 65 6E 74 73 2E 63 6F 6D 2F 64 6F ',
      '77 6E 6C 6F 61 64 2F 6D 61 63 3F 64 6C 3D 61 31 ',
      '62 32 63 33 64 34 65 35 66 36 61 37 62 38 63 39 ',
      '64 30 61 31 62 32 63 33 64 34 65 35 66 36 61 37 ',
      '62 38 63 39 64 30 61 31 62 32 63 33 64 34 5F 10 ',
      '21 68 74 74 70 73 3A 2F 2F 70 6C 61 74 66 6F 72 ',
      '6D 2E 67 61 6D 75 74 61 67 65 6E 74 73 2E 63 6F ',
      '6D 2F 08 0B 6E 00 00 00 00 00 00 01 01 00 00 00 ',
      '00 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00 ',
      '00 00 00 00 92',
      '',
    ].join('\n')
    expect(extractNonceFromWhereFromsHex(realXattrOutput)).toBe(NONCE)
  })

  it('tolerates lowercase, unspaced hex', () => {
    const fakePlist = Buffer.concat([
      Buffer.from('bplist00\xa2\x01\x02_\x10', 'latin1'),
      Buffer.from(`https://updates.gamutagents.com/download/mac?dl=${NONCE}`),
      Buffer.from('_\x10https://platform.gamutagents.com/', 'latin1'),
    ])
    expect(extractNonceFromWhereFromsHex(fakePlist.toString('hex'))).toBe(NONCE)
  })

  it('returns null for empty or malformed output', () => {
    expect(extractNonceFromWhereFromsHex('')).toBeNull()
    expect(extractNonceFromWhereFromsHex('zz zz')).toBeNull()
  })
})

describe('extractNoncesFromHdiutilPlist', () => {
  const plist = (...imagePaths: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>images</key><array>${imagePaths
    .map(
      (p) => `<dict>
    <key>image-path</key><string>${p}</string>
    <key>system-entities</key><array><dict>
      <key>mount-point</key><string>/Volumes/Gamut</string>
    </dict></array>
  </dict>`,
    )
    .join('')}</array>
</dict></plist>`

  it('recovers the code from a mounted stamped DMG', () => {
    expect(
      extractNoncesFromHdiutilPlist(plist(`/Users/x/Downloads/Gamut-1.2.3-${NONCE}.dmg`)),
    ).toEqual([NONCE])
  })

  it('returns every stamped product DMG — a stale mount must not shadow a fresh one', () => {
    const STALE = 'ffff'.repeat(12)
    expect(
      extractNoncesFromHdiutilPlist(
        plist(
          `/Users/x/Downloads/Gamut-1.2.2-${STALE}.dmg`,
          `/Users/x/Downloads/Gamut-1.2.3-${NONCE}.dmg`,
        ),
      ),
    ).toEqual([STALE, NONCE])
  })

  it('ignores non-product DMGs even when their names carry hex runs', () => {
    expect(
      extractNoncesFromHdiutilPlist(plist(`/Users/x/Downloads/OtherApp-${NONCE}.dmg`)),
    ).toEqual([])
  })

  it('ignores unstamped product DMGs and non-DMG strings', () => {
    expect(extractNoncesFromHdiutilPlist(plist('/Users/x/Downloads/Gamut-1.2.3.dmg'))).toEqual([])
    expect(extractNoncesFromHdiutilPlist('<string>/Volumes/whatever</string>')).toEqual([])
  })
})

describe('deriveMacBundlePath', () => {
  it('extracts the bundle root from a packaged executable path', () => {
    expect(deriveMacBundlePath('/Applications/Gamut.app/Contents/MacOS/Gamut')).toBe(
      '/Applications/Gamut.app',
    )
  })

  it('returns null outside a bundle', () => {
    expect(deriveMacBundlePath('/usr/local/bin/node')).toBeNull()
  })
})
