export interface AgentMemoryEntry {
  path: string
  title: string
  description: string
  type?: string
  isIndex: boolean
}

export interface AgentMemoryDocument extends AgentMemoryEntry {
  content: string
  body: string
  revision: string
}
