
import {
  Globe,
  MousePointerClick,
  TextCursorInput,
  ArrowDownUp,
  Hourglass,
  Keyboard,
  Camera,
  CircleDot,
  MousePointer2,
  Terminal,
} from 'lucide-react'
import type { ToolRenderer } from './types'
import {
  browserOpenDef, browserCloseDef, browserSnapshotDef,
  browserClickDef, browserFillDef, browserScrollDef,
  browserWaitDef, browserPressDef, browserScreenshotDef,
  browserSelectDef, browserHoverDef, browserRunDef,
} from '@shared/lib/tool-definitions/browser-tools'

export const browserOpenRenderer: ToolRenderer = { displayName: browserOpenDef.displayName, icon: Globe, getSummary: browserOpenDef.getSummary }
export const browserCloseRenderer: ToolRenderer = { displayName: browserCloseDef.displayName, icon: Globe }
export const browserSnapshotRenderer: ToolRenderer = { displayName: browserSnapshotDef.displayName, icon: Camera }
export const browserClickRenderer: ToolRenderer = { displayName: browserClickDef.displayName, icon: MousePointerClick, getSummary: browserClickDef.getSummary }
export const browserFillRenderer: ToolRenderer = { displayName: browserFillDef.displayName, icon: TextCursorInput, getSummary: browserFillDef.getSummary }
export const browserScrollRenderer: ToolRenderer = { displayName: browserScrollDef.displayName, icon: ArrowDownUp, getSummary: browserScrollDef.getSummary }
export const browserWaitRenderer: ToolRenderer = { displayName: browserWaitDef.displayName, icon: Hourglass, getSummary: browserWaitDef.getSummary }
export const browserPressRenderer: ToolRenderer = { displayName: browserPressDef.displayName, icon: Keyboard, getSummary: browserPressDef.getSummary }
export const browserScreenshotRenderer: ToolRenderer = { displayName: browserScreenshotDef.displayName, icon: Camera, getSummary: browserScreenshotDef.getSummary, ExpandedView: () => null }
export const browserSelectRenderer: ToolRenderer = { displayName: browserSelectDef.displayName, icon: CircleDot, getSummary: browserSelectDef.getSummary }
export const browserHoverRenderer: ToolRenderer = { displayName: browserHoverDef.displayName, icon: MousePointer2, getSummary: browserHoverDef.getSummary }
export const browserRunRenderer: ToolRenderer = { displayName: browserRunDef.displayName, icon: Terminal, getSummary: browserRunDef.getSummary }
