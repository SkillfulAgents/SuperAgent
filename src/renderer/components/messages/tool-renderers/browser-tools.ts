
import {
  Globe,
  X,
  ScanEye,
  MousePointerClick,
  TextCursorInput,
  ArrowDownUp,
  Timer,
  Keyboard,
  Camera,
  ChevronDown,
  MousePointer,
  Terminal,
} from 'lucide-react'
import type { ToolRenderer } from './types'

// ── browser_open ──────────────────────────────────────────────

export const browserOpenRenderer: ToolRenderer = {
  displayName: 'Open Browser',
  icon: Globe,
  getSummary: (input) => {
    const { url } = input as { url?: string }
    return url ?? null
  },
}

// ── browser_close ─────────────────────────────────────────────

export const browserCloseRenderer: ToolRenderer = {
  displayName: 'Close Browser',
  icon: X,
}

// ── browser_snapshot ──────────────────────────────────────────

export const browserSnapshotRenderer: ToolRenderer = {
  displayName: 'Page Snapshot',
  icon: ScanEye,
}

// ── browser_click ─────────────────────────────────────────────

export const browserClickRenderer: ToolRenderer = {
  displayName: 'Click',
  icon: MousePointerClick,
  getSummary: (input) => {
    const { ref } = input as { ref?: string }
    return ref ?? null
  },
}

// ── browser_fill ──────────────────────────────────────────────

export const browserFillRenderer: ToolRenderer = {
  displayName: 'Fill Input',
  icon: TextCursorInput,
  getSummary: (input) => {
    const { ref, value } = input as { ref?: string; value?: string }
    if (!ref) return null
    const truncated = value && value.length > 30 ? value.slice(0, 27) + '...' : value
    return truncated ? `${ref} ← "${truncated}"` : ref
  },
}

// ── browser_scroll ────────────────────────────────────────────

export const browserScrollRenderer: ToolRenderer = {
  displayName: 'Scroll',
  icon: ArrowDownUp,
  getSummary: (input) => {
    const { direction, amount } = input as { direction?: string; amount?: number }
    if (!direction) return null
    return amount ? `${direction} ${amount}px` : direction
  },
}

// ── browser_wait ──────────────────────────────────────────────

export const browserWaitRenderer: ToolRenderer = {
  displayName: 'Wait',
  icon: Timer,
  getSummary: (input) => {
    const { for: condition } = input as { for?: string }
    return condition ?? null
  },
}

// ── browser_press ─────────────────────────────────────────────

export const browserPressRenderer: ToolRenderer = {
  displayName: 'Key Press',
  icon: Keyboard,
  getSummary: (input) => {
    const { key } = input as { key?: string }
    return key ?? null
  },
}

// ── browser_screenshot ────────────────────────────────────────

export const browserScreenshotRenderer: ToolRenderer = {
  displayName: 'Screenshot',
  icon: Camera,
  getSummary: (input) => {
    const { full } = input as { full?: boolean }
    return full ? 'full page' : 'viewport'
  },
}

// ── browser_select ────────────────────────────────────────────

export const browserSelectRenderer: ToolRenderer = {
  displayName: 'Select Option',
  icon: ChevronDown,
  getSummary: (input) => {
    const { ref, value } = input as { ref?: string; value?: string }
    if (!ref || !value) return ref ?? null
    return `"${value}" in ${ref}`
  },
}

// ── browser_hover ─────────────────────────────────────────────

export const browserHoverRenderer: ToolRenderer = {
  displayName: 'Hover',
  icon: MousePointer,
  getSummary: (input) => {
    const { ref } = input as { ref?: string }
    return ref ?? null
  },
}

// ── browser_run ───────────────────────────────────────────────

export const browserRunRenderer: ToolRenderer = {
  displayName: 'Browser Command',
  icon: Terminal,
  getSummary: (input) => {
    const { command } = input as { command?: string }
    if (!command) return null
    const firstLine = command.split('\n')[0]
    return firstLine.length > 50 ? `$ ${firstLine.slice(0, 47)}...` : `$ ${firstLine}`
  },
}
