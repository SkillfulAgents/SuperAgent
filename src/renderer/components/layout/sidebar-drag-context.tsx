import { createContext, useContext } from 'react'

export type SidebarDragType = 'agent' | 'folder' | null

/**
 * What is currently being dragged in the left nav, if anything.
 *
 * Two rows need this. Agent rows are collapsible — an expanded one carries its
 * sessions and dashboards with it — so leaving them open during a drag makes
 * the drop geometry tall and jumpy as rows reflow underneath the cursor; they
 * render collapsed for the duration WITHOUT touching their own `isOpen` state,
 * so nothing refetches and every row springs back on drop. And a row being
 * hovered by a dragged *folder* has to show where that folder will land, since
 * folder drags deliberately suppress the sortable shift preview.
 */
const SidebarDragContext = createContext<SidebarDragType>(null)

export const SidebarDragProvider = SidebarDragContext.Provider

export function useSidebarDragType(): SidebarDragType {
  return useContext(SidebarDragContext)
}

export function useSidebarDragActive(): boolean {
  return useContext(SidebarDragContext) !== null
}

