import { describe, it, expect } from 'vitest'
import { parseCsv } from './csv-parse'

describe('parseCsv', () => {
  it('parses a simple comma-separated file', () => {
    const { headers, rows, delimiter, columnCount } = parseCsv('name,age\nAlice,30\nBob,25')
    expect(delimiter).toBe(',')
    expect(columnCount).toBe(2)
    expect(headers).toEqual(['name', 'age'])
    expect(rows).toEqual([
      ['Alice', '30'],
      ['Bob', '25'],
    ])
  })

  it('handles quoted fields containing the delimiter', () => {
    const { rows } = parseCsv('name,note\nAlice,"hello, world"')
    expect(rows[0]).toEqual(['Alice', 'hello, world'])
  })

  it('handles escaped quotes inside quoted fields', () => {
    const { rows } = parseCsv('value\n"she said ""hi"""')
    expect(rows[0]).toEqual(['she said "hi"'])
  })

  it('handles embedded newlines inside quoted fields', () => {
    const { headers, rows } = parseCsv('name,bio\nAlice,"line one\nline two"')
    expect(headers).toEqual(['name', 'bio'])
    expect(rows).toEqual([['Alice', 'line one\nline two']])
  })

  it('detects a tab delimiter', () => {
    const { delimiter, headers, rows } = parseCsv('name\tage\nAlice\t30')
    expect(delimiter).toBe('\t')
    expect(headers).toEqual(['name', 'age'])
    expect(rows).toEqual([['Alice', '30']])
  })

  it('detects a semicolon delimiter', () => {
    const { delimiter, headers } = parseCsv('a;b;c\n1;2;3')
    expect(delimiter).toBe(';')
    expect(headers).toEqual(['a', 'b', 'c'])
  })

  it('pads ragged rows to a rectangular shape', () => {
    const { columnCount, headers, rows } = parseCsv('a,b,c\n1,2\n4,5,6,7')
    expect(columnCount).toBe(4)
    expect(headers).toEqual(['a', 'b', 'c', ''])
    expect(rows[0]).toEqual(['1', '2', '', ''])
    expect(rows[1]).toEqual(['4', '5', '6', '7'])
  })

  it('preserves blank lines so row numbers stay aligned (no trailing empty row)', () => {
    const { rows } = parseCsv('a,b\n1,2\n\n3,4\n')
    expect(rows).toEqual([
      ['1', '2'],
      ['', ''],
      ['3', '4'],
    ])
  })

  it('keeps a blank cell in a single-column file (does not shift later rows)', () => {
    const { rows } = parseCsv('name\nAlice\n\nBob')
    expect(rows).toEqual([['Alice'], [''], ['Bob']])
  })

  it('detects a tab delimiter despite commas inside quoted fields', () => {
    const text = '"Last, First"\tScore\n"Doe, John"\t90\n"Roe, Jane"\t85'
    const { delimiter, headers, rows } = parseCsv(text)
    expect(delimiter).toBe('\t')
    expect(headers).toEqual(['Last, First', 'Score'])
    expect(rows).toEqual([
      ['Doe, John', '90'],
      ['Roe, Jane', '85'],
    ])
  })

  it('does not overflow the stack on a file with millions of rows', () => {
    const huge = 'x\n'.repeat(1_000_000)
    expect(() => parseCsv(huge)).not.toThrow()
    const { columnCount, rows } = parseCsv(huge)
    expect(columnCount).toBe(1)
    expect(rows.length).toBe(999_999) // header consumes the first row
  })

  it('handles CRLF line endings', () => {
    const { headers, rows } = parseCsv('a,b\r\n1,2\r\n3,4')
    expect(headers).toEqual(['a', 'b'])
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('returns empty headers for an empty file', () => {
    const { headers, rows, columnCount } = parseCsv('')
    expect(headers).toEqual([])
    expect(rows).toEqual([])
    expect(columnCount).toBe(0)
  })

  it('treats a single-column file as a one-column table', () => {
    const { columnCount, headers, rows } = parseCsv('url\nhttps://a.com\nhttps://b.com')
    expect(columnCount).toBe(1)
    expect(headers).toEqual(['url'])
    expect(rows).toEqual([['https://a.com'], ['https://b.com']])
  })
})
