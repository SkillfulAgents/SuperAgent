'use client'

import { FilePlus, Loader2 } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

interface WriteInput {
  file_path?: string
  content?: string
}

function parseWriteInput(input: unknown): WriteInput {
  if (typeof input === 'object' && input !== null) {
    return input as WriteInput
  }
  return {}
}

/**
 * Extract a string value from partial JSON that may be incomplete
 * Handles cases like: {"content": "partial text here...
 */
function extractPartialString(json: string, key: string): string | null {
  // Look for "key": " pattern (the opening quote of the value)
  const keyPattern = `"${key}":`
  const keyIndex = json.indexOf(keyPattern)
  if (keyIndex === -1) return null

  // Find the opening quote of the value (skip whitespace)
  let valueStart = keyIndex + keyPattern.length
  while (valueStart < json.length && /\s/.test(json[valueStart])) {
    valueStart++
  }

  // Must have an opening quote
  if (valueStart >= json.length || json[valueStart] !== '"') {
    return null
  }

  // Start after the opening quote
  valueStart++

  // Extract the value, handling escape sequences
  let value = ''
  let i = valueStart

  while (i < json.length) {
    const char = json[i]

    // Handle escape sequences
    if (char === '\\') {
      if (i + 1 >= json.length) {
        // Incomplete escape at end of string - stop here
        break
      }
      const nextChar = json[i + 1]
      switch (nextChar) {
        case 'n': value += '\n'; break
        case 't': value += '\t'; break
        case 'r': value += '\r'; break
        case '"': value += '"'; break
        case '\\': value += '\\'; break
        case '/': value += '/'; break
        default: value += nextChar; break
      }
      i += 2
      continue
    }

    // End of string value
    if (char === '"') {
      break
    }

    value += char
    i++
  }

  // Return the value even if empty (means key exists but value is empty/still coming)
  return value
}

function getDisplayPath(filePath: string): string {
  // Show shortened path for common prefixes
  if (filePath.startsWith('/workspace/')) {
    return filePath.replace('/workspace/', '')
  }
  return filePath
}

function getSummary(input: unknown): string | null {
  const { file_path } = parseWriteInput(input)
  if (file_path) {
    return `→ ${getDisplayPath(file_path)}`
  }
  return null
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { file_path, content } = parseWriteInput(input)

  return (
    <div className="space-y-2">
      {/* File path */}
      {file_path && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">File</div>
          <div className="bg-background rounded p-2 text-xs font-mono truncate">
            {file_path}
          </div>
        </div>
      )}

      {/* Content being written */}
      {content && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Content</div>
          <pre className="bg-background rounded p-2 text-xs overflow-x-auto max-h-60 overflow-y-auto font-mono">
            {content}
          </pre>
        </div>
      )}

      {/* Result */}
      {result && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {isError ? 'Error' : 'Result'}
          </div>
          <pre
            className={`rounded p-2 text-xs overflow-x-auto font-mono ${
              isError ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200' : 'bg-background text-green-600 dark:text-green-400'
            }`}
          >
            {result}
          </pre>
        </div>
      )}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  // Always use extraction for streaming - it handles both complete and incomplete JSON
  // JSON.parse would fail to show content that's still being streamed
  const filePath = extractPartialString(partialInput, 'file_path')
  const content = extractPartialString(partialInput, 'content')

  // Count lines being written
  const lineCount = content?.split('\n').length || 0

  return (
    <div className="space-y-2">
      {/* Always show file section */}
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">File</div>
        <div className="bg-background rounded p-2 text-xs font-mono">
          {filePath || <span className="text-muted-foreground italic">...</span>}
        </div>
      </div>

      {/* Show content if key exists (even if empty - means streaming started) */}
      {content !== null && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            Content {lineCount > 0 && `(${lineCount} ${lineCount === 1 ? 'line' : 'lines'})`}
          </div>
          <pre className="bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto font-mono whitespace-pre-wrap">
            {content || <span className="text-muted-foreground">...</span>}
            <span className="animate-pulse">|</span>
          </pre>
        </div>
      )}

      {/* Show generating state while Claude is thinking about what to write */}
      {content === null && filePath && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Content</div>
          <div className="bg-background rounded p-2 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Generating...</span>
          </div>
        </div>
      )}
    </div>
  )
}

export const writeRenderer: ToolRenderer = {
  icon: FilePlus,
  getSummary,
  ExpandedView,
  StreamingView,
}
