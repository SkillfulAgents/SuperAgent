export interface MockStreamState {
  isActive: boolean
  isStreaming: boolean
  streamingMessage: string | null
  streamingToolUses: Array<{ id: string; name: string; partialInput: string; ready?: boolean }>
  pendingBrowserInputRequests: Array<{ toolUseId: string; message: string; requirements: string[] }>
  autoApprovedScriptRunIds: ReadonlySet<string>
  autoApprovedComputerUseIds: ReadonlySet<string>
  error: string | null
  browserActive: boolean
  activeStartTime: number | null
  isCompacting: boolean
  contextUsage: null
  activeSubagent: null
  slashCommands: Array<{ name: string; description: string; argumentHint: string }>
}

export const DEFAULT_STREAM_STATE: MockStreamState = {
  isActive: false,
  isStreaming: false,
  streamingMessage: null,
  streamingToolUses: [],
  pendingBrowserInputRequests: [],
  autoApprovedScriptRunIds: new Set(),
  autoApprovedComputerUseIds: new Set(),
  error: null,
  browserActive: false,
  activeStartTime: null,
  isCompacting: false,
  contextUsage: null,
  activeSubagent: null,
  slashCommands: [],
}

export function createMockStreamState(overrides: Partial<MockStreamState> = {}): MockStreamState {
  return { ...DEFAULT_STREAM_STATE, ...overrides }
}
