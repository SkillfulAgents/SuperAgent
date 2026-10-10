import { defineToolRenderer } from '../renderer-types'
import { Search } from 'lucide-react'
import { grepDef } from './definition'

export const grepRenderer = defineToolRenderer(grepDef, {
  icon: Search,
})
