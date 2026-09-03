export const subagentBlock = {
  SubAgentBlock: ({
    toolCall,
    activeSubagent,
    isCompleted,
  }: {
    toolCall: { name: string }
    activeSubagent?: { parentToolId: string } | null
    isCompleted?: boolean
  }) => (
    <div
      data-testid="subagent-block"
      data-active-parent={activeSubagent?.parentToolId ?? ''}
      data-completed={String(!!isCompleted)}
    >
      {toolCall.name}
    </div>
  ),
}

export const toolCallItem = {
  ToolCallItem: ({ toolCall }: { toolCall: { name: string } }) => (
    <div data-testid={`tool-call-${toolCall.name}`}>{toolCall.name}</div>
  ),
  StreamingToolCallItem: ({ name }: { name: string }) => (
    <div data-testid="streaming-tool-call">{name}</div>
  ),
}

export const messageContextMenu = {
  MessageContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}

export const tooltip = {
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span data-testid="tooltip-content">{children}</span>,
}
