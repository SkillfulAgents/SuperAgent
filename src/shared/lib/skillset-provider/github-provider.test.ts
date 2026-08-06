import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSettings = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}))

import { GithubSkillsetProvider } from './github-provider'

describe('GithubSkillsetProvider repository credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockReturnValue({ skillsetCredentials: {} })
  })

  it('passes a transient token through a process-scoped Git extraHeader', () => {
    const provider = new GithubSkillsetProvider()
    const token = 'github_pat_test_secret'
    const environment = provider.getGitEnvironment({
      skillsetId: 'private',
      skillsetUrl: 'https://github.com/Org/private.git',
      credential: { type: 'token', token },
    }, { GIT_TERMINAL_PROMPT: '0' })

    expect(environment.GIT_CONFIG_COUNT).toBe('2')
    expect(environment.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader')
    expect(environment.GIT_CONFIG_VALUE_0).toBe('')
    expect(environment.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraHeader')
    expect(environment.GIT_CONFIG_VALUE_1).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    )
    expect(JSON.stringify(environment)).not.toContain(`x-access-token:${token}`)
  })

  it('resolves a stored token from an opaque providerData reference', () => {
    mockGetSettings.mockReturnValue({
      skillsets: [],
      skillsetCredentials: {
        skillcred_1: { type: 'token', token: 'stored-secret' },
      },
    })
    const provider = new GithubSkillsetProvider()
    const environment = provider.getCliEnvironment({
      skillsetId: 'private',
      skillsetUrl: 'https://github.com/Org/private.git',
      providerData: { credentialId: 'skillcred_1' },
    }, {})

    expect(environment.GH_TOKEN).toBe('stored-secret')
  })

  it('prefers the current skillset credential over an installed metadata snapshot', () => {
    mockGetSettings.mockReturnValue({
      skillsets: [{ id: 'private', providerData: { credentialId: 'skillcred_current' } }],
      skillsetCredentials: {
        skillcred_snapshot: { type: 'token', token: 'stale-secret' },
        skillcred_current: { type: 'token', token: 'current-secret' },
      },
    })
    const provider = new GithubSkillsetProvider()
    const environment = provider.getCliEnvironment({
      skillsetId: 'private',
      skillsetUrl: 'https://github.com/Org/private.git',
      providerData: { credentialId: 'skillcred_snapshot' },
    }, {})

    expect(environment.GH_TOKEN).toBe('current-secret')
  })

  it('uses a credential added after the skill was installed from a public repository', () => {
    mockGetSettings.mockReturnValue({
      skillsets: [{ id: 'private', providerData: { credentialId: 'skillcred_current' } }],
      skillsetCredentials: {
        skillcred_current: { type: 'token', token: 'new-secret' },
      },
    })
    const provider = new GithubSkillsetProvider()
    const environment = provider.getCliEnvironment({
      skillsetId: 'private',
      skillsetUrl: 'https://github.com/Org/private.git',
    }, {})

    expect(environment.GH_TOKEN).toBe('new-secret')
  })

  it('does not fall back to a stale snapshot after the current token is removed', () => {
    mockGetSettings.mockReturnValue({
      skillsets: [{ id: 'private' }],
      skillsetCredentials: {
        skillcred_snapshot: { type: 'token', token: 'stale-secret' },
      },
    })
    const provider = new GithubSkillsetProvider()
    const environment = provider.getCliEnvironment({
      skillsetId: 'private',
      skillsetUrl: 'https://github.com/Org/private.git',
      providerData: { credentialId: 'skillcred_snapshot' },
    }, {})

    expect(environment.GH_TOKEN).toBeUndefined()
  })

  it('rejects embedded URL credentials', async () => {
    const provider = new GithubSkillsetProvider()
    await expect(provider.resolveCloneUrl(
      'https://user:secret@github.com/Org/private.git',
      { skillsetId: 'private', skillsetUrl: 'https://user:secret@github.com/Org/private.git' },
    )).rejects.toThrow('Do not put credentials in the repository URL')
  })

  it('rejects tokens for SSH URLs', () => {
    const provider = new GithubSkillsetProvider()
    expect(() => provider.getGitEnvironment({
      skillsetId: 'private',
      skillsetUrl: 'git@github.com:Org/private.git',
      credential: { type: 'token', token: 'secret' },
    }, {})).toThrow('HTTPS github.com URLs only')
  })

  it('fails clearly when an opaque credential reference is missing', () => {
    const provider = new GithubSkillsetProvider()
    expect(() => provider.getGitEnvironment({
      skillsetId: 'private',
      skillsetUrl: 'https://github.com/Org/private.git',
      providerData: { credentialId: 'missing' },
    }, {})).toThrow('repository credential is missing')
  })
})
