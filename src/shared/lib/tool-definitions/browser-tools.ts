import type { ToolDefinition } from './types'

function noSummary(): null { return null }

export const browserOpenDef: ToolDefinition = {
  displayName: 'Open Browser', iconName: 'Globe',
  getSummary: (input) => (input as { url?: string }).url ?? null,
}

export const browserCloseDef: ToolDefinition = {
  displayName: 'Close Browser', iconName: 'X', getSummary: noSummary,
}

export const browserSnapshotDef: ToolDefinition = {
  displayName: 'Page Snapshot', iconName: 'ScanEye', getSummary: noSummary,
}

export const browserClickDef: ToolDefinition = {
  displayName: 'Click', iconName: 'MousePointerClick',
  getSummary: (input) => (input as { ref?: string }).ref ?? null,
}

export const browserFillDef: ToolDefinition = {
  displayName: 'Fill Input', iconName: 'TextCursorInput',
  getSummary: (input) => {
    const { ref, value } = input as { ref?: string; value?: string }
    if (!ref) return null
    const truncated = value && value.length > 30 ? value.slice(0, 27) + '...' : value
    return truncated ? `${ref} ← "${truncated}"` : ref
  },
}

export const browserScrollDef: ToolDefinition = {
  displayName: 'Scroll', iconName: 'ArrowDownUp',
  getSummary: (input) => {
    const { direction, amount } = input as { direction?: string; amount?: number }
    if (!direction) return null
    return amount ? `${direction} ${amount}px` : direction
  },
}

export const browserWaitDef: ToolDefinition = {
  displayName: 'Wait', iconName: 'Timer',
  getSummary: (input) => (input as { for?: string }).for ?? null,
}

export const browserPressDef: ToolDefinition = {
  displayName: 'Key Press', iconName: 'Keyboard',
  getSummary: (input) => (input as { key?: string }).key ?? null,
}

export const browserScreenshotDef: ToolDefinition = {
  displayName: 'Screenshot', iconName: 'Camera',
  getSummary: (input) => (input as { full?: boolean }).full ? 'full page' : 'viewport',
}

export const browserSelectDef: ToolDefinition = {
  displayName: 'Select Option', iconName: 'ChevronDown',
  getSummary: (input) => {
    const { ref, value } = input as { ref?: string; value?: string }
    if (!ref || !value) return ref ?? null
    return `"${value}" in ${ref}`
  },
}

export const browserHoverDef: ToolDefinition = {
  displayName: 'Hover', iconName: 'MousePointer',
  getSummary: (input) => (input as { ref?: string }).ref ?? null,
}

export const browserRunDef: ToolDefinition = {
  displayName: 'Browser Command', iconName: 'Terminal',
  getSummary: (input) => {
    const { command } = input as { command?: string }
    if (!command) return null
    const firstLine = command.split('\n')[0]
    return firstLine.length > 50 ? `$ ${firstLine.slice(0, 47)}...` : `$ ${firstLine}`
  },
}
