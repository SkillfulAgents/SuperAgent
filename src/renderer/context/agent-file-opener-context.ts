import { createContext } from 'react'

/**
 * Opens an agent's file or folder in the side panel. Separate from
 * FilePreviewContext, whose value changes with every tab, comment and page, so a
 * link that only opens files does not re-render with the panel.
 */
export interface AgentFileOpener {
  openFile: (filePath: string, agentSlug: string) => void
  openFolder: (folderPath: string, agentSlug: string) => void
}

export const AgentFileOpenerContext = createContext<AgentFileOpener | null>(null)
