import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Label } from '@renderer/components/ui/label'
import {
  useAgentRemoteMcps,
  useRemoteMcps,
  useAssignMcpToAgent,
  useRemoveMcpFromAgent,
} from '@renderer/hooks/use-remote-mcps'
import { useDialogs } from '@renderer/context/dialog-context'
import { Plus, Trash2, Loader2, Plug } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

interface RemoteMcpsTabProps {
  agentSlug: string
  onClose?: () => void
}

export function RemoteMcpsTab({ agentSlug, onClose }: RemoteMcpsTabProps) {
  const { data: agentMcpsData, isLoading: isLoadingAgentMcps } = useAgentRemoteMcps(agentSlug)
  const { data: allMcpsData, isLoading: isLoadingAllMcps } = useRemoteMcps()
  const assignMcp = useAssignMcpToAgent()
  const removeMcp = useRemoveMcpFromAgent()

  const { openSettings } = useDialogs()
  const [selectedMcps, setSelectedMcps] = useState<Set<string>>(new Set())
  const [isAdding, setIsAdding] = useState(false)

  const openGlobalMcpSettings = () => {
    onClose?.()
    openSettings('remote-mcps')
  }

  const agentMcps = Array.isArray(agentMcpsData?.mcps) ? agentMcpsData.mcps : []
  const allMcps = Array.isArray(allMcpsData?.servers) ? allMcpsData.servers : []

  // Filter out MCPs already assigned to this agent
  const assignedIds = new Set(agentMcps.map((m) => m.id))
  const availableMcps = allMcps.filter((m) => !assignedIds.has(m.id))

  const handleToggleMcp = (mcpId: string) => {
    setSelectedMcps((prev) => {
      const next = new Set(prev)
      if (next.has(mcpId)) {
        next.delete(mcpId)
      } else {
        next.add(mcpId)
      }
      return next
    })
  }

  const handleAddSelected = async () => {
    if (selectedMcps.size === 0) return
    await assignMcp.mutateAsync({
      agentSlug,
      mcpIds: Array.from(selectedMcps),
    })
    setSelectedMcps(new Set())
    setIsAdding(false)
  }

  const handleRemove = async (mcpId: string) => {
    await removeMcp.mutateAsync({ agentSlug, mcpId })
  }

  const isLoading = isLoadingAgentMcps || isLoadingAllMcps

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">Remote MCP Servers</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Grant this agent access to remote MCP servers for additional tools and capabilities.
          {' '}
          <button
            type="button"
            onClick={openGlobalMcpSettings}
            className="text-primary hover:underline"
          >
            Manage global MCP servers
          </button>
        </p>
      </div>

      {/* Current agent MCPs */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading MCP servers...
        </div>
      ) : agentMcps.length > 0 ? (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">MCP servers this agent can access:</Label>
          {agentMcps.map((mcp) => (
            <div
              key={mcp.id}
              className="flex items-center justify-between p-3 rounded-md border bg-muted/30"
            >
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <Plug className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{mcp.name}</p>
                    <span
                      className={cn(
                        'text-xs px-1.5 py-0.5 rounded',
                        mcp.status === 'active'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                          : mcp.status === 'auth_required'
                          ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                          : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                      )}
                    >
                      {mcp.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {mcp.url} · {mcp.tools.length} tools
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleRemove(mcp.id)}
                disabled={removeMcp.isPending}
              >
                {removeMcp.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 text-destructive" />
                )}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No MCP servers assigned to this agent yet.
        </p>
      )}

      {/* Add MCPs section */}
      {!isAdding ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsAdding(true)}
          disabled={availableMcps.length === 0}
        >
          <Plus className="h-4 w-4 mr-2" />
          {availableMcps.length === 0
            ? 'No MCP servers available'
            : 'Add MCP servers'}
        </Button>
      ) : (
        <div className="space-y-4 p-4 border rounded-md">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Select MCP servers to add:</Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsAdding(false)
                setSelectedMcps(new Set())
              }}
            >
              Cancel
            </Button>
          </div>

          {availableMcps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No more MCP servers available.{' '}
              <button
                type="button"
                onClick={openGlobalMcpSettings}
                className="text-primary hover:underline"
              >
                Register new servers
              </button>
            </p>
          ) : (
            <div className="space-y-2">
              {availableMcps.map((mcp) => (
                <div
                  key={mcp.id}
                  className="flex items-center space-x-3 p-2 rounded hover:bg-muted/50"
                >
                  <Checkbox
                    id={`mcp-${mcp.id}`}
                    checked={selectedMcps.has(mcp.id)}
                    onCheckedChange={() => handleToggleMcp(mcp.id)}
                  />
                  <label
                    htmlFor={`mcp-${mcp.id}`}
                    className="flex-1 cursor-pointer"
                  >
                    <p className="text-sm font-medium">{mcp.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {mcp.url} · {mcp.tools.length} tools
                    </p>
                  </label>
                  <span
                    className={cn(
                      'text-xs px-1.5 py-0.5 rounded',
                      mcp.status === 'active'
                        ? 'bg-green-100 text-green-700'
                        : mcp.status === 'auth_required'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-red-100 text-red-700'
                    )}
                  >
                    {mcp.status}
                  </span>
                </div>
              ))}
            </div>
          )}

          {selectedMcps.size > 0 && (
            <Button
              size="sm"
              onClick={handleAddSelected}
              disabled={assignMcp.isPending}
            >
              {assignMcp.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                <>Add {selectedMcps.size} server(s)</>
              )}
            </Button>
          )}
        </div>
      )}

      {allMcps.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No MCP servers registered.{' '}
          <button
            type="button"
            onClick={openGlobalMcpSettings}
            className="text-primary hover:underline"
          >
            Register servers in global settings
          </button>
        </p>
      )}
    </div>
  )
}
