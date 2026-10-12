import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, Database, MinusCircle } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { s3InputConfigSchema, type S3InputConfig } from '@shared/lib/volumes/s3-schema'
import { volumeValidationSchema, type VolumeValidation } from '@shared/lib/volumes/volume-validation-schema'
import { VolumeDetailsFields, VolumeSetupFooter, VolumeSetupHeader } from './volume-setup-layout'
import type { VolumeSetupDefinition, VolumeSetupProps } from './volume-setup'

function S3Logo({ className }: { className?: string }) { return <Database aria-hidden className={className} /> }

function ValidationResult({ result }: { result: VolumeValidation }) {
  return <div className="space-y-3" role="status" aria-live="polite" data-testid="s3-validation-result">
    <p className={`text-sm font-medium ${result.valid ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`}>
      {result.valid ? 'Connected — this key has the access the volume needs.' : 'This key is not ready to mount. Check the items below.'}
    </p>
    <ul className="space-y-2 text-xs">
      {result.checks.map(check => <li key={check.label} className="flex items-start gap-2">
        {check.status === 'passed' ? <CheckCircle2 aria-label="Passed" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          : check.status === 'failed' ? <CircleAlert aria-label="Failed" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          : <MinusCircle aria-label="Not checked" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span>{check.label}{check.message && <span className="mt-0.5 block text-muted-foreground">{check.message}</span>}</span>
      </li>)}
    </ul>
    {result.warnings.map(warning => <p key={warning} className="break-words rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">{warning}</p>)}
    {!result.valid && <p className="text-xs text-muted-foreground">Use a key with list, read, write, delete, and multipart upload access to this bucket and prefix. For Cloudflare R2, choose Object Read &amp; Write.</p>}
  </div>
}

function S3VolumeSetup({ initialDetails, onSubmit, onBack, onCancel, isSaving, error, clearError, attachToAgent }: VolumeSetupProps) {
  const [step, setStep] = useState<'connection' | 'details'>('connection')
  const [config, setConfig] = useState<S3InputConfig>({ endpoint: '', bucket: '', region: 'us-east-1', prefix: '', forcePathStyle: true, credentials: { accessKeyId: '', secretAccessKey: '' } })
  const [details, setDetails] = useState(initialDetails)
  const [result, setResult] = useState<VolumeValidation | null>(null)
  const [checking, setChecking] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (result) resultRef.current?.focus() }, [result])
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const update = (next: S3InputConfig) => { setConfig(next); setResult(null); setConnectionError(null); clearError() }
  const parsed = s3InputConfigSchema.safeParse(config)

  const check = async () => {
    if (checking || !parsed.success) return
    const request = new AbortController()
    controller.current = request
    setChecking(true); setResult(null); setConnectionError(null)
    try {
      const response = await apiFetch('/api/volume-types/s3/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data), signal: request.signal })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error('Could not check this bucket. Check the connection details and try again.')
      if (!request.signal.aborted) setResult(volumeValidationSchema.parse(data))
    } catch (err) {
      if (!request.signal.aborted) setConnectionError(err instanceof Error ? err.message : 'Could not check this bucket. Please try again.')
    } finally { if (!request.signal.aborted) setChecking(false) }
  }
  const next = () => {
    setDetails(value => ({ ...value, name: value.name || config.prefix.split('/').filter(Boolean).at(-1) || config.bucket }))
    setStep('details')
  }
  return <>
    <VolumeSetupHeader title={step === 'connection' ? 'Connect an S3 bucket' : 'Set up S3 volume'}
      description={step === 'connection' ? 'Works with Amazon S3, Cloudflare R2, and compatible storage.' : 'Name this volume and choose who can attach it.'}
      Logo={S3Logo} steps={['Source', 'Connection', 'Details']} step={step === 'connection' ? 1 : 2} />
    <form className="space-y-4" onSubmit={event => {
      event.preventDefault()
      if (step === 'details') { if (result?.valid && parsed.success) void onSubmit(parsed.data, details) }
      else if (result?.valid) next()
      else void check()
    }}>
      <div className="max-h-[55vh] space-y-4 overflow-y-auto px-0.5">
        {step === 'connection' ? <>
          <div className="space-y-1.5"><Label htmlFor="s3-endpoint">Endpoint URL</Label>
            <Input id="s3-endpoint" type="url" placeholder="https://account.r2.cloudflarestorage.com" value={config.endpoint} disabled={checking} onChange={event => {
              const endpoint = event.target.value
              update({ ...config, endpoint, region: endpoint.includes('.r2.cloudflarestorage.com') ? 'auto' : config.region })
            }} />
            <p className="text-xs text-muted-foreground">Leave blank for Amazon S3. Use your provider’s S3 API endpoint.</p>
          </div>
          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <div className="space-y-1.5"><Label htmlFor="s3-bucket">Bucket</Label><Input id="s3-bucket" value={config.bucket} disabled={checking} onChange={event => update({ ...config, bucket: event.target.value })} required /></div>
            <div className="space-y-1.5"><Label htmlFor="s3-region">Region</Label><Input id="s3-region" value={config.region} disabled={checking} onChange={event => update({ ...config, region: event.target.value })} required /></div>
          </div>
          <div className="space-y-1.5"><Label htmlFor="s3-access-key">Access key ID</Label><Input id="s3-access-key" autoComplete="off" spellCheck={false} value={config.credentials.accessKeyId} disabled={checking} onChange={event => update({ ...config, credentials: { ...config.credentials, accessKeyId: event.target.value } })} required /></div>
          <div className="space-y-1.5"><Label htmlFor="s3-secret-key">Secret access key</Label><Input id="s3-secret-key" type="password" autoComplete="new-password" value={config.credentials.secretAccessKey} disabled={checking} onChange={event => update({ ...config, credentials: { ...config.credentials, secretAccessKey: event.target.value } })} required /></div>
          <div className="space-y-1.5"><Label htmlFor="s3-prefix">Folder prefix (optional)</Label><Input id="s3-prefix" placeholder="e.g. shared/documents" value={config.prefix} disabled={checking} onChange={event => update({ ...config, prefix: event.target.value })} />
            <p className="text-xs text-muted-foreground">Leave blank to mount the whole bucket. Access stays within this prefix.</p>
          </div>
          <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Advanced</summary><div className="mt-3 space-y-3">
            <div className="space-y-1.5"><Label htmlFor="s3-session-token">Session token (optional)</Label><Input id="s3-session-token" type="password" autoComplete="off" disabled={checking} value={config.credentials.sessionToken ?? ''} onChange={event => update({ ...config, credentials: { ...config.credentials, sessionToken: event.target.value || undefined } })} /></div>
            <label className="flex items-center gap-2"><input type="checkbox" checked={config.forcePathStyle} disabled={checking} onChange={event => update({ ...config, forcePathStyle: event.target.checked })} />Use path-style bucket URLs</label>
          </div></details>
        </> : <VolumeDetailsFields value={details} onChange={value => { setDetails(value); clearError() }} disabled={isSaving}>
          <div className="rounded-md border bg-muted/30 p-3 text-sm"><p className="font-medium">{config.bucket}</p><p className="mt-1 break-all text-xs text-muted-foreground">{config.prefix || 'Entire bucket'} · {config.region}</p></div>
        </VolumeDetailsFields>}
        {result && <div ref={resultRef} tabIndex={-1} className="outline-none"><ValidationResult result={result} /></div>}
        {(connectionError || error) && <p role="alert" className="text-sm text-destructive">{connectionError || error}</p>}
      </div>
      {step === 'connection' && <p className="text-xs text-muted-foreground">Checking access creates temporary test objects inside this prefix, then removes them.</p>}
      <VolumeSetupFooter onBack={step === 'connection' ? onBack : () => { setStep('connection'); clearError() }} onCancel={onCancel}
        isSaving={checking || isSaving} disabled={step === 'connection' ? !parsed.success : !details.name.trim() || !result?.valid}
        submitLabel={step === 'details' ? attachToAgent ? 'Create and attach' : 'Create volume' : checking ? 'Checking access…' : result?.valid ? 'Continue' : 'Test connection'} />
    </form>
  </>
}

export const s3VolumeSetup = {
  type: 's3', label: 'S3-compatible bucket', description: 'Amazon S3, Cloudflare R2, and more.', Logo: S3Logo,
  configSchema: s3InputConfigSchema, isAvailable: () => true, Setup: S3VolumeSetup,
} satisfies VolumeSetupDefinition<'s3'>
