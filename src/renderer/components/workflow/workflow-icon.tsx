import { createLucideIcon } from 'lucide-react'

/**
 * A workflow's icon everywhere: lucide's `diagram-flow-horizontal`, one step
 * branching to the next. Lucide ships it from 1.77; this app is on 1.40, so its
 * paths are copied here (ISC, Lucide Icons and Contributors). Swap for the
 * library export once lucide-react is bumped past 1.77.
 */
export const WorkflowIcon = createLucideIcon('diagram-flow-horizontal', [
  ['path', { d: 'M8 12h.5a3.5 3.5 0 013.5 3.5 3.5 3.5 0 003.5 3.5h.5', key: '1b2vhw' }],
  ['path', { d: 'M8.5 12A3.5 3.5 0 0012 8.5 3.5 3.5 0 0115.5 5h.5', key: 'k43232' }],
  ['rect', { x: '16', y: '16', width: '6', height: '6', rx: '1', key: '4q2zg0' }],
  ['rect', { x: '16', y: '2', width: '6', height: '6', rx: '1', key: '2gbqrp' }],
  ['rect', { x: '2', y: '9', width: '6', height: '6', rx: '1', key: 'po7qyj' }],
])
