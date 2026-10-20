import { useState } from 'react'
import { useConnectedAccountsByToolkit } from '@renderer/hooks/use-connected-accounts'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { githubVolumeConfigSchema, type GithubVolumeConfig } from '@shared/lib/volumes/github-schema'
import { VolumeAccountStep, VolumeRemoteDetailsStep } from './volume-account-step'
import { VolumeFolderPicker, type VolumeFolderSource } from './volume-folder-picker'
import { VolumeSetupHeader } from './volume-setup-layout'
import type { VolumeSetupDefinition, VolumeSetupProps } from './volume-setup'

function GithubLogo({ className }: { className?: string }) {
  return <ServiceIcon slug="github" className={className} />
}

type GithubCursor = { id: string; name: string }[]
const githubFolders: VolumeFolderSource<GithubCursor> = {
  type: 'github', label: 'GitHub',
  title: 'Select a GitHub folder', description: 'Choose a repository, then a branch and folder.',
  query: (accountId, cursor): Record<string, string> => {
    const [repo, branch] = cursor
    if (!repo) return { accountId }
    if (!branch) return { accountId, repoId: repo.id }
    return { accountId, repoId: repo.id, branch: branch.id, path: cursor.length > 2 ? cursor.at(-1)?.id ?? '' : '' }
  },
  folders: (data, cursor) => data.folders.map(folder => ({ id: folder.id, name: folder.name, cursor: [...cursor, folder] })),
  location: cursor => cursor.map(folder => folder.name).join(' / ') || 'GitHub',
  parent: cursor => cursor.length ? cursor.slice(0, -1) : null,
  selectLabel: cursor => cursor.length < 2 ? null : cursor.length === 2 ? 'Use repository root' : 'Use this folder',
}

function GithubVolumeSetup({ initialDetails, onSubmit, onBack, onCancel, isSaving, error, clearError, attachToAgent }: VolumeSetupProps) {
  const accounts = useConnectedAccountsByToolkit('github')
  const [step, setStep] = useState<'account' | 'details'>('account')
  const [accountId, setAccountId] = useState('')
  const [config, setConfig] = useState<GithubVolumeConfig | null>(null)
  const [details, setDetails] = useState(initialDetails)
  const account = accounts.data?.accounts.find(item => item.id === accountId)
  const active = account?.status === 'active' && !accounts.error

  const selectAccount = (id: string) => {
    if (!id || id === accountId) return
    if (config && details.name === (config.path.split('/').at(-1) || config.repo)) setDetails({ ...details, name: '' })
    setAccountId(id)
    setConfig(null)
    clearError()
  }

  return <>
    <VolumeSetupHeader title={step === 'account' ? 'Connect GitHub' : 'Set up GitHub drive'}
      description={step === 'account' ? 'Choose an account or connect a new one.' : 'Select a repository, branch and folder, then name this drive.'}
      Logo={GithubLogo} steps={['Source', 'Account', 'Details']} step={step === 'account' ? 1 : 2} />
    {step === 'account' ? <VolumeAccountStep toolkit="github" label="GitHub" accounts={accounts} accountId={accountId} active={active}
      onSelect={selectAccount} onNext={() => { clearError(); setStep('details') }} onBack={onBack} onCancel={onCancel} />
    : <VolumeRemoteDetailsStep label="GitHub" accountName={account?.displayName} active={active} details={details}
      onDetailsChange={value => { setDetails(value); clearError() }} isSaving={isSaving} error={error} canSave={!!config} attachToAgent={attachToAgent}
      onSave={() => { if (config) void onSubmit(config, details) }} onBack={() => { clearError(); setStep('account') }} onCancel={onCancel}>
      <VolumeFolderPicker key={accountId} source={githubFolders} accountId={accountId} initial={[]}
        selected={config ? `${config.owner}/${config.repo}@${config.branch}${config.path ? `/${config.path}` : ''}` : null} disabled={isSaving || !active} onChange={cursor => {
          const [repository, branch] = cursor
          if (!repository || !branch) return
          const [owner, repo] = repository.name.split('/')
          const path = cursor.length > 2 ? cursor.at(-1)?.id ?? '' : ''
          const previousName = config?.path.split('/').at(-1) || config?.repo
          setConfig({ accountId, repoId: Number(repository.id), owner, repo, branch: branch.id, path })
          setDetails(current => !current.name || current.name === previousName ? { ...current, name: path.split('/').at(-1) || repo } : current)
          clearError()
        }} />
      <p className="text-xs text-muted-foreground">This drive is read-only. GitHub changes appear after the drive checks the branch in the background.</p>
    </VolumeRemoteDetailsStep>}
  </>
}

export const githubVolumeSetup = {
  type: 'github', label: 'GitHub', description: 'Connect an account and choose a repository, branch and folder.', Logo: GithubLogo,
  configSchema: githubVolumeConfigSchema, isAvailable: () => true, Setup: GithubVolumeSetup,
} satisfies VolumeSetupDefinition<'github'>
