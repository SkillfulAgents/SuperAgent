
import { Search } from 'lucide-react'
import { grepDef } from '@shared/lib/tool-definitions/grep'
import type { ToolRenderer } from './types'

export const grepRenderer: ToolRenderer = {
  displayName: grepDef.displayName,
  icon: Search,
  getSummary: grepDef.getSummary,
}
