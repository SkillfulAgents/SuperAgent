import { useState, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Loader2, Copy, Check } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'

interface SystemInfo {
  app: {
    version: string
    electronVersion: string | null
    chromeVersion: string | null
    nodeVersion: string
  }
  os: {
    platform: string
    type: string
    release: string
    version: string
    arch: string
  }
  hardware: {
    cpuModel: string | null
    cpuCores: number
    totalMemoryBytes: number
    freeMemoryBytes: number
  }
  disk: {
    totalBytes: number
    freeBytes: number
  } | null
  runtime: {
    uptime: number
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)
  return parts.join(' ')
}

function formatPlainText(info: SystemInfo): string {
  const lines = [
    `App Version: ${info.app.version}`,
  ]
  if (info.app.electronVersion) lines.push(`Electron: ${info.app.electronVersion}`)
  if (info.app.chromeVersion) lines.push(`Chrome: ${info.app.chromeVersion}`)
  lines.push(`Node: ${info.app.nodeVersion}`)
  lines.push(`Platform: ${info.os.platform} (${info.os.arch})`)
  lines.push(`OS: ${info.os.type} ${info.os.release}`)
  if (info.hardware.cpuModel) {
    lines.push(`CPU: ${info.hardware.cpuModel} (${info.hardware.cpuCores} cores)`)
  }
  lines.push(`Memory: ${formatBytes(info.hardware.freeMemoryBytes)} / ${formatBytes(info.hardware.totalMemoryBytes)} free`)
  if (info.disk) {
    lines.push(`Disk: ${formatBytes(info.disk.freeBytes)} / ${formatBytes(info.disk.totalBytes)} free`)
  }
  lines.push(`Uptime: ${formatUptime(info.runtime.uptime)}`)
  return lines.join('\n')
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <Label className="text-muted-foreground">{label}</Label>
      <span>{value}</span>
    </>
  )
}

interface DeviceInfoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeviceInfoDialog({ open, onOpenChange }: DeviceInfoDialogProps) {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const fetchInfo = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/api/debug/system-info')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setInfo(await res.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchInfo()
    }
  }, [open, fetchInfo])

  const handleCopy = useCallback(() => {
    if (!info) return
    navigator.clipboard.writeText(formatPlainText(info))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [info])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Device Info</DialogTitle>
          <DialogDescription className="sr-only">System and hardware information for debugging</DialogDescription>
        </DialogHeader>
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && (
          <p className="text-xs text-destructive py-4">Failed to load system info: {error}</p>
        )}
        {info && (
          <div className="space-y-4">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <InfoRow label="App Version" value={info.app.version} />
              {info.app.electronVersion && (
                <InfoRow label="Electron" value={info.app.electronVersion} />
              )}
              {info.app.chromeVersion && (
                <InfoRow label="Chrome" value={info.app.chromeVersion} />
              )}
              <InfoRow label="Node" value={info.app.nodeVersion} />
              <InfoRow label="Platform" value={`${info.os.platform} (${info.os.arch})`} />
              <InfoRow label="OS" value={`${info.os.type} ${info.os.release}`} />
              {info.hardware.cpuModel && (
                <InfoRow label="CPU" value={`${info.hardware.cpuModel} (${info.hardware.cpuCores} cores)`} />
              )}
              <InfoRow
                label="Memory"
                value={`${formatBytes(info.hardware.freeMemoryBytes)} / ${formatBytes(info.hardware.totalMemoryBytes)} free`}
              />
              {info.disk && (
                <InfoRow
                  label="Disk"
                  value={`${formatBytes(info.disk.freeBytes)} / ${formatBytes(info.disk.totalBytes)} free`}
                />
              )}
              <InfoRow label="Uptime" value={formatUptime(info.runtime.uptime)} />
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
                {copied ? 'Copied' : 'Copy to Clipboard'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
