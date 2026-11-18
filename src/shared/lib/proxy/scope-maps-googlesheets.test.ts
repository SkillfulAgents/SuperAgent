import { describe, expect, it } from 'vitest'
import { matchScopes } from './scope-matcher'
import { SCOPE_MAPS } from './scope-maps'
import { getScopeLabel } from './scope-metadata'
import { canonicalizeTargetPath, rawRouteTail } from './target-path'

const HOST = 'sheets.googleapis.com'
const ROOT = 'v4/spreadsheets'
const READ_SCOPES = ['drive', 'drive.file', 'drive.readonly', 'spreadsheets', 'spreadsheets.readonly']
const WRITE_SCOPES = ['drive', 'drive.file', 'spreadsheets']

// Complete Sheets v4 contract, checked against discovery revision 20261014:
// https://sheets.googleapis.com/$discovery/rest?version=v4
// Google only lists write-capable scopes for filtered reads and developer metadata.
const ENDPOINTS = [
  ['POST', ROOT, WRITE_SCOPES],
  ['GET', `${ROOT}/sheet-id`, READ_SCOPES],
  ['POST', `${ROOT}/sheet-id:getByDataFilter`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id:batchUpdate`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id/sheets/123:copyTo`, WRITE_SCOPES],
  ['GET', `${ROOT}/sheet-id/values/Sheet1!A1:B2`, READ_SCOPES],
  ['PUT', `${ROOT}/sheet-id/values/Sheet1!A1:B2`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id/values/Sheet1!A1:B2:append`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id/values/Sheet1!A1:B2:clear`, WRITE_SCOPES],
  ['GET', `${ROOT}/sheet-id/values:batchGet`, READ_SCOPES],
  ['POST', `${ROOT}/sheet-id/values:batchGetByDataFilter`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id/values:batchUpdate`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id/values:batchUpdateByDataFilter`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id/values:batchClear`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id/values:batchClearByDataFilter`, WRITE_SCOPES],
  ['GET', `${ROOT}/sheet-id/developerMetadata/456`, WRITE_SCOPES],
  ['POST', `${ROOT}/sheet-id/developerMetadata:search`, WRITE_SCOPES],
] as const

function normalize(path: string, host = HOST) {
  const raw = rawRouteTail(
    `http://localhost/api/proxy/agent/account/${host}/${path}?valueInputOption=RAW&ranges=Other%2FRange`,
    '/api/proxy/:agentSlug/:accountId/:rest{.+}',
    'rest',
  )
  const target = canonicalizeTargetPath(raw, host)
  if (!target.ok) throw new Error(target.error)
  return target
}

describe('Google Sheets endpoint contract', () => {
  it('covers every mapped Sheets method', () => {
    expect(ENDPOINTS).toHaveLength(17)
    expect(SCOPE_MAPS.googlesheets.scopeMap).toHaveLength(ENDPOINTS.length)
  })

  it.each(ENDPOINTS)('classifies %s %s with the documented scopes', (method, path, scopes) => {
    for (const spelling of [path, path.split('/').map(encodeURIComponent).join('/')]) {
      const target = normalize(spelling)
      const result = matchScopes('googlesheets', method, target.path, HOST)
      expect(result.matched).toBe(true)
      expect(result.scopes.toSorted()).toEqual([...scopes].sort())
      expect(result.endpointDescription).toBeTruthy()
      expect(result.endpointAmbiguous).not.toBe(true)
      const labels = result.scopes.map((scope) => getScopeLabel('googlesheets', scope))
      expect(labels).not.toContain(undefined)
      expect(labels).toContain(scopes.includes('spreadsheets.readonly') ? 'read' : 'write')
      if (!scopes.includes('spreadsheets.readonly')) expect(labels).not.toContain('read')
    }
  })

  it.each([
    'Sheet1!A1:B2',
    'A1:B2',
    'Named_Range',
    "'Quarterly Sales'!A:A",
    "'October/2026'!A1:B2",
    "'Costs #1'!A1:B2",
    "'Question?'!A1:B2",
    "'Literal %2F'!A1:B2",
    "'O''Brien'!A1:B2",
    "'収支 2026'!A1:B2",
    "'.. / Notes'!A1:B2",
  ])('keeps range %s intact for all four range endpoints', (range) => {
    for (const host of [HOST, 'Sheets.GoogleApis.Com']) {
      for (const [method, suffix, scopes] of [
        ['GET', '', READ_SCOPES],
        ['PUT', '', WRITE_SCOPES],
        ['POST', ':append', WRITE_SCOPES],
        ['POST', ':clear', WRITE_SCOPES],
      ] as const) {
        const path = `${ROOT}/sheet-id/values/${encodeURIComponent(range)}${suffix}`
        const target = normalize(path, host)
        // The proxy must forward the encoded range exactly as received.
        expect(target.encodedPath).toBe(path)
        expect(target.path.split('/')).toHaveLength(5)
        const result = matchScopes('googlesheets', method, target.path, host)
        expect(result.matched).toBe(true)
        expect(result.scopes.toSorted()).toEqual([...scopes].sort())
      }
    }
  })

  it.each([
    ['POST', `${ROOT}/sheet-id:unknownAction`],
    ['POST', `${ROOT}/:batchUpdate`],
    ['POST', `${ROOT}/sheet-id/values/Sheet1!A1:B2:unknownAction`],
    ['POST', `${ROOT}/sheet-id/values/:append`],
    ['POST', `${ROOT}/sheet-id:batchUpdate/extra`],
    ['DELETE', `${ROOT}/sheet-id`],
    ['GET', `${ROOT}/sheet-id/unknownResource/id`],
  ])('keeps unknown or invalid %s %s unclassified', (method, path) => {
    expect(matchScopes('googlesheets', method, normalize(path).path, HOST).matched).toBe(false)
  })

  it('keeps Drive exports scoped to the fallback host and provider', () => {
    const result = matchScopes('googlesheets', 'GET', '/drive/v3/files/id/export', 'www.googleapis.com')
    expect(result.matched).toBe(true)
    expect(result.scopes).toContain('googledrive:drive.readonly')
    expect(matchScopes('googlesheets', 'GET', '/drive/v3/files/id/export', HOST).matched).toBe(false)
  })
})
