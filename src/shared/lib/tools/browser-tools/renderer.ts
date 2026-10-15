import { defineToolRenderer } from '../renderer-types'
import {
  Braces,
  Download,
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
import {
  browserOpenDef, browserCloseDef, browserSnapshotDef,
  browserClickDef, browserFillDef, browserScrollDef,
  browserWaitDef, browserPressDef, browserTypeDef, browserScreenshotDef,
  browserSelectDef, browserHoverDef, browserDownloadDef, browserEvalDef, browserRunDef,
} from './definition'

export const browserOpenRenderer = defineToolRenderer(browserOpenDef, {
  icon: Globe,
})
export const browserCloseRenderer = defineToolRenderer(browserCloseDef, {
  icon: Globe,
})
export const browserSnapshotRenderer = defineToolRenderer(browserSnapshotDef, {
  icon: Camera,
})
export const browserClickRenderer = defineToolRenderer(browserClickDef, {
  icon: MousePointerClick,
})
export const browserFillRenderer = defineToolRenderer(browserFillDef, {
  icon: TextCursorInput,
})
export const browserScrollRenderer = defineToolRenderer(browserScrollDef, {
  icon: ArrowDownUp,
})
export const browserWaitRenderer = defineToolRenderer(browserWaitDef, {
  icon: Hourglass,
})
export const browserPressRenderer = defineToolRenderer(browserPressDef, {
  icon: Keyboard,
})
export const browserTypeRenderer = defineToolRenderer(browserTypeDef, {
  icon: Keyboard,
})
export const browserScreenshotRenderer = defineToolRenderer(browserScreenshotDef, {
  icon: Camera,
  ExpandedView: () => null,
})
export const browserSelectRenderer = defineToolRenderer(browserSelectDef, {
  icon: CircleDot,
})
export const browserHoverRenderer = defineToolRenderer(browserHoverDef, {
  icon: MousePointer2,
})
export const browserDownloadRenderer = defineToolRenderer(browserDownloadDef, {
  icon: Download,
})
export const browserEvalRenderer = defineToolRenderer(browserEvalDef, {
  icon: Braces,
})
export const browserRunRenderer = defineToolRenderer(browserRunDef, {
  icon: Terminal,
})
