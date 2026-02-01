import { describe, it, expect } from 'vitest'
import { parseToolResult } from './parse-tool-result'

describe('parseToolResult', () => {
  describe('null/undefined input', () => {
    it('returns null text and no images for null', () => {
      const result = parseToolResult(null)
      expect(result).toEqual({ text: null, images: [] })
    })

    it('returns null text and no images for undefined', () => {
      const result = parseToolResult(undefined)
      expect(result).toEqual({ text: null, images: [] })
    })
  })

  describe('plain string input', () => {
    it('returns the string as text', () => {
      const result = parseToolResult('hello world')
      expect(result).toEqual({ text: 'hello world', images: [] })
    })

    it('returns empty string as text', () => {
      const result = parseToolResult('')
      expect(result).toEqual({ text: '', images: [] })
    })

    it('handles strings with ANSI escape codes', () => {
      const ansi = '\u001b[32m✓\u001b[0m Screenshot saved to \u001b[32m/tmp/screenshot.png\u001b[0m'
      const result = parseToolResult(ansi)
      expect(result.text).toBe(ansi)
      expect(result.images).toEqual([])
    })

    it('does not recurse into JSON strings that are not arrays', () => {
      const json = JSON.stringify({ key: 'value' })
      const result = parseToolResult(json)
      expect(result.text).toBe(json)
      expect(result.images).toEqual([])
    })
  })

  describe('JSON-serialized content block arrays', () => {
    it('parses a JSON string containing text blocks', () => {
      const json = JSON.stringify([{ type: 'text', text: 'parsed text' }])
      const result = parseToolResult(json)
      expect(result).toEqual({ text: 'parsed text', images: [] })
    })

    it('parses a JSON string containing image blocks (MCP format)', () => {
      const json = JSON.stringify([
        { type: 'image', data: 'abc123', mimeType: 'image/png' },
      ])
      const result = parseToolResult(json)
      expect(result.text).toBeNull()
      expect(result.images).toEqual([{ data: 'abc123', mimeType: 'image/png' }])
    })

    it('parses a JSON string containing mixed text and image blocks', () => {
      const json = JSON.stringify([
        { type: 'text', text: 'some text' },
        { type: 'image', data: 'imgdata', mimeType: 'image/jpeg' },
      ])
      const result = parseToolResult(json)
      expect(result.text).toBe('some text')
      expect(result.images).toEqual([{ data: 'imgdata', mimeType: 'image/jpeg' }])
    })
  })

  describe('content block arrays (objects)', () => {
    it('extracts text from a single text block', () => {
      const result = parseToolResult([{ type: 'text', text: 'hello' }])
      expect(result).toEqual({ text: 'hello', images: [] })
    })

    it('concatenates multiple text blocks with newlines', () => {
      const result = parseToolResult([
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ])
      expect(result).toEqual({ text: 'line 1\nline 2', images: [] })
    })

    it('extracts images in Anthropic API format', () => {
      const result = parseToolResult([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
        },
      ])
      expect(result.text).toBeNull()
      expect(result.images).toEqual([{ data: 'base64data', mimeType: 'image/png' }])
    })

    it('extracts images in MCP format', () => {
      const result = parseToolResult([
        { type: 'image', data: 'mcpdata', mimeType: 'image/jpeg' },
      ])
      expect(result.text).toBeNull()
      expect(result.images).toEqual([{ data: 'mcpdata', mimeType: 'image/jpeg' }])
    })

    it('handles mixed text and multiple images', () => {
      const result = parseToolResult([
        { type: 'text', text: 'screenshot results' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'img1' } },
        { type: 'image', data: 'img2', mimeType: 'image/jpeg' },
      ])
      expect(result.text).toBe('screenshot results')
      expect(result.images).toHaveLength(2)
      expect(result.images[0]).toEqual({ data: 'img1', mimeType: 'image/png' })
      expect(result.images[1]).toEqual({ data: 'img2', mimeType: 'image/jpeg' })
    })

    it('returns null text for image-only arrays', () => {
      const result = parseToolResult([
        { type: 'image', data: 'data', mimeType: 'image/png' },
      ])
      expect(result.text).toBeNull()
    })

    it('skips unknown block types', () => {
      const result = parseToolResult([
        { type: 'text', text: 'hello' },
        { type: 'audio', data: 'audiodata' },
      ])
      expect(result.text).toBe('hello')
      expect(result.images).toEqual([])
    })

    it('skips image blocks with missing data', () => {
      const result = parseToolResult([
        { type: 'image' },
        { type: 'image', source: { type: 'base64' } },
        { type: 'image', data: 'valid', mimeType: 'image/png' },
      ])
      expect(result.images).toHaveLength(1)
      expect(result.images[0]).toEqual({ data: 'valid', mimeType: 'image/png' })
    })

    it('returns null text for empty arrays', () => {
      const result = parseToolResult([])
      expect(result).toEqual({ text: null, images: [] })
    })
  })

  describe('single content block objects', () => {
    it('extracts text from a single text block object', () => {
      const result = parseToolResult({ type: 'text', text: 'single block' })
      expect(result).toEqual({ text: 'single block', images: [] })
    })

    it('extracts image from a single Anthropic format image block', () => {
      const result = parseToolResult({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'singleimg' },
      })
      expect(result.text).toBeNull()
      expect(result.images).toEqual([{ data: 'singleimg', mimeType: 'image/png' }])
    })

    it('extracts image from a single MCP format image block', () => {
      const result = parseToolResult({
        type: 'image',
        data: 'mcpimg',
        mimeType: 'image/webp',
      })
      expect(result.text).toBeNull()
      expect(result.images).toEqual([{ data: 'mcpimg', mimeType: 'image/webp' }])
    })
  })

  describe('fallback for unrecognized objects', () => {
    it('stringifies unrecognized objects', () => {
      const obj = { foo: 'bar', count: 42 }
      const result = parseToolResult(obj)
      expect(result.text).toBe(JSON.stringify(obj, null, 2))
      expect(result.images).toEqual([])
    })

    it('stringifies objects with unknown type field', () => {
      const obj = { type: 'unknown_type', payload: 'data' }
      const result = parseToolResult(obj)
      expect(result.text).toBe(JSON.stringify(obj, null, 2))
      expect(result.images).toEqual([])
    })
  })
})
