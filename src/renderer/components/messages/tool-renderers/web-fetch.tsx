
import { Globe } from 'lucide-react'
import { webFetchDef } from '@shared/lib/tool-definitions/web-fetch'
import type { ToolRenderer } from './types'

export const webFetchRenderer: ToolRenderer = {
  displayName: webFetchDef.displayName,
  icon: Globe,
  getSummary: webFetchDef.getSummary,
}
