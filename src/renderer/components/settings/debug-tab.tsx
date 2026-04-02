import { useState, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { apiFetch } from '@renderer/lib/api'
import { Loader2, RefreshCw, Terminal, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react'

interface AppInfo {
  platform: string
  execPath: string
  nodeVersion: string
  electronVersion: string | null
  terminalCommand: string
}

interface RuntimeInfo {
  configuredRunner: string
  platform: string
  runners: { runner: string; installed: boolean; running: boolean; available: boolean }[]
  vmStatus: Record<string, unknown> | null
  readiness: { status: string; message: string }
}

interface ContainerEntry {
  ID?: string
  Names?: string
  Image?: string
  Status?: string
  State?: string
  Command?: string
  [key: string]: unknown
}

interface ContainersResponse {
  containers?: ContainerEntry[]
  raw?: string
  error?: string
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 min-w-0">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </div>
  )
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto overflow-y-auto max-h-64 w-0 min-w-full">
      {children}
    </pre>
  )
}

export function DebugTab() {
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)

  const [containers, setContainers] = useState<ContainersResponse | null>(null)
  const [containersLoading, setContainersLoading] = useState(false)
  const [containersError, setContainersError] = useState<string | null>(null)

  const [logsMap, setLogsMap] = useState<Record<string, string>>({})
  const [logsLoading, setLogsLoading] = useState<Record<string, boolean>>({})
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({})

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)

  // Fetch app info on mount (lightweight, no shell commands)
  useEffect(() => {
    apiFetch('/api/debug/app-info')
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setAppInfo(data) })
      .catch(() => {})
  }, [])

  const copyCommand = useCallback((text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  const fetchRuntime = useCallback(async () => {
    setRuntimeLoading(true)
    setRuntimeError(null)
    try {
      const res = await apiFetch('/api/debug/runtime')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRuntimeInfo(await res.json())
    } catch (e: any) {
      setRuntimeError(e.message)
    } finally {
      setRuntimeLoading(false)
    }
  }, [])

  const fetchContainers = useCallback(async () => {
    setContainersLoading(true)
    setContainersError(null)
    try {
      const res = await apiFetch('/api/debug/containers')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setContainers(await res.json())
    } catch (e: any) {
      setContainersError(e.message)
    } finally {
      setContainersLoading(false)
    }
  }, [])

  const fetchLogs = useCallback(async (containerName: string) => {
    setLogsLoading(prev => ({ ...prev, [containerName]: true }))
    try {
      const res = await apiFetch(`/api/debug/containers/${encodeURIComponent(containerName)}/logs?tail=200`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setLogsMap(prev => ({ ...prev, [containerName]: data.logs || data.error || 'No logs' }))
      setExpandedLogs(prev => ({ ...prev, [containerName]: true }))
    } catch (e: any) {
      setLogsMap(prev => ({ ...prev, [containerName]: `Error: ${e.message}` }))
    } finally {
      setLogsLoading(prev => ({ ...prev, [containerName]: false }))
    }
  }, [])

  const toggleLogs = (name: string) => {
    setExpandedLogs(prev => ({ ...prev, [name]: !prev[name] }))
  }

  return (
    <div className="space-y-6 min-w-0 overflow-hidden">
      {/* App Logs */}
      {appInfo && (
        <Section title="App Logs">
          <p className="text-xs text-muted-foreground">
            To see app logs, quit the app and relaunch it from a terminal:
          </p>
          <div className="relative">
            <Pre>{appInfo.terminalCommand}</Pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-1.5 right-1.5 h-6 w-6 p-0"
              onClick={() => copyCommand(appInfo.terminalCommand)}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-2">
            <Label className="text-muted-foreground">Platform</Label>
            <span>{appInfo.platform}</span>
            {appInfo.electronVersion && (
              <>
                <Label className="text-muted-foreground">Electron</Label>
                <span>{appInfo.electronVersion}</span>
              </>
            )}
            <Label className="text-muted-foreground">Node</Label>
            <span>{appInfo.nodeVersion}</span>
          </div>
        </Section>
      )}

      {/* Runtime / VM Status */}
      <Section title="Runtime & VM Status">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchRuntime} disabled={runtimeLoading}>
            {runtimeLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            {runtimeInfo ? 'Refresh' : 'Load Status'}
          </Button>
        </div>
        {runtimeError && <p className="text-xs text-destructive">{runtimeError}</p>}
        {runtimeInfo && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <Label className="text-muted-foreground">Configured Runner</Label>
              <span>{runtimeInfo.configuredRunner}</span>
              <Label className="text-muted-foreground">Platform</Label>
              <span>{runtimeInfo.platform}</span>
              <Label className="text-muted-foreground">Readiness</Label>
              <span>{runtimeInfo.readiness.status} — {runtimeInfo.readiness.message}</span>
            </div>

            {/* Runner availability */}
            <div>
              <Label className="text-xs text-muted-foreground">Runners</Label>
              <div className="mt-1 rounded-md border text-xs">
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left p-2 font-medium">Runner</th>
                      <th className="text-left p-2 font-medium">Installed</th>
                      <th className="text-left p-2 font-medium">Running</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runtimeInfo.runners.map(r => (
                      <tr key={r.runner} className="border-b last:border-0">
                        <td className="p-2">{r.runner}</td>
                        <td className="p-2">{r.installed ? 'Yes' : 'No'}</td>
                        <td className="p-2">{r.running ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* VM-specific status */}
            {runtimeInfo.vmStatus && (
              <div>
                <Label className="text-xs text-muted-foreground">VM / Runtime Details</Label>
                <Pre>{JSON.stringify(runtimeInfo.vmStatus, null, 2)}</Pre>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Containers */}
      <Section title="Containers">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchContainers} disabled={containersLoading}>
            {containersLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Terminal className="h-4 w-4 mr-2" />}
            {containers ? 'Refresh' : 'List Containers'}
          </Button>
        </div>
        {containersError && <p className="text-xs text-destructive">{containersError}</p>}
        {containers && (
          <div>
            {containers.error && <p className="text-xs text-destructive">{containers.error}</p>}
            {containers.raw && <Pre>{containers.raw}</Pre>}
            {containers.containers && containers.containers.length === 0 && (
              <p className="text-xs text-muted-foreground">No containers found.</p>
            )}
            {containers.containers && containers.containers.length > 0 && (
              <div className="space-y-2">
                {containers.containers.map((ct, i) => {
                  const name = ct.Names || ct.ID || `container-${i}`
                  const isExpanded = expandedLogs[name]
                  return (
                    <div key={name} className="rounded-md border text-xs">
                      <div className="flex items-center justify-between p-2 bg-muted/30">
                        <div className="space-y-0.5">
                          <div className="font-medium">{name}</div>
                          <div className="text-muted-foreground">
                            {ct.Image && <span>Image: {ct.Image}</span>}
                            {ct.Status && <span className="ml-3">Status: {ct.Status}</span>}
                            {ct.State && <span className="ml-3">State: {ct.State}</span>}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (!logsMap[name]) {
                              fetchLogs(name)
                            } else {
                              toggleLogs(name)
                            }
                          }}
                          disabled={logsLoading[name]}
                        >
                          {logsLoading[name] ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : isExpanded ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          <span className="ml-1">Logs</span>
                        </Button>
                      </div>
                      {isExpanded && logsMap[name] && (
                        <div className="border-t p-2">
                          <div className="flex justify-end mb-1">
                            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => fetchLogs(name)} disabled={logsLoading[name]}>
                              <RefreshCw className="h-3 w-3 mr-1" />
                              Refresh
                            </Button>
                          </div>
                          <Pre>{logsMap[name]}</Pre>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}
