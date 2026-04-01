export interface MockStreamState {
  isActive: boolean
  isStreaming: boolean
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string; partialInput: string } | null
  pendingSecretRequests: Array<{ toolUseId: string; secretName: string; reason?: string }>
  pendingConnectedAccountRequests: Array<{ toolUseId: string; toolkit: string; reason?: string }>
  pendingQuestionRequests: Array<{
    toolUseId: string
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiSelect: boolean
    }>
  }>
  pendingFileRequests: Array<{ toolUseId: string; description: string; fileTypes?: string }>
  pendingRemoteMcpRequests: Array<{ toolUseId: string; url: string; name?: string; reason?: string }>
  pendingBrowserInputRequests: Array<{ toolUseId: string; message: string; requirements: string[] }>
  pendingScriptRunRequests: Array<{ toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }>
  pendingComputerUseRequests: Array<{ toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string }>
  pendingBrowserUseRequests: Array<{ toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; domain?: string }>
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
  streamingToolUse: null,
  pendingSecretRequests: [],
  pendingConnectedAccountRequests: [],
  pendingQuestionRequests: [],
  pendingFileRequests: [],
  pendingRemoteMcpRequests: [],
  pendingBrowserInputRequests: [],
  pendingScriptRunRequests: [],
  pendingComputerUseRequests: [],
  pendingBrowserUseRequests: [],
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
