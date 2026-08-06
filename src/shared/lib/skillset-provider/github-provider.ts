import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { getSettings } from '@shared/lib/config/settings'
import { ensureDirectory } from '@shared/lib/utils/file-storage'
import {
  BaseSkillsetProvider,
  type SkillsetProviderRef,
  type SkillsetPublishInput,
  type SkillsetPublishResult,
} from './base-skillset-provider'

const execFileAsync = promisify(execFile)

const BASE_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
}

function appendGitConfig(
  environment: NodeJS.ProcessEnv,
  key: string,
  value: string,
): NodeJS.ProcessEnv {
  const rawCount = Number.parseInt(environment.GIT_CONFIG_COUNT ?? '0', 10)
  const index = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : 0
  return {
    ...environment,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: key,
    [`GIT_CONFIG_VALUE_${index}`]: value,
  }
}

interface ForkBranchContext {
  repoDir: string
  upstreamNwo: string
  forkOwner: string
  baseBranch: string
  branchName: string
  gitEnvironment: NodeJS.ProcessEnv
  cliEnvironment: NodeJS.ProcessEnv
}

export class GithubSkillsetProvider extends BaseSkillsetProvider {
  readonly id = 'github'
  readonly name = 'GitHub'
  readonly publishMode = 'pull_request' as const

  private getToken(ref: SkillsetProviderRef): string | undefined {
    if (ref.credential?.type === 'token') return ref.credential.token

    const settings = getSettings()
    const currentSkillset = settings.skillsets?.find((skillset) => skillset.id === ref.skillsetId)
    // Installed skill/agent metadata is a historical snapshot. Prefer the
    // live skillset binding so adding, removing, or replacing a credential
    // takes effect without reinstalling. Fall back only when the skillset is
    // no longer configured, preserving legacy metadata behavior.
    const credentialId = currentSkillset
      ? currentSkillset.providerData?.credentialId
      : ref.providerData?.credentialId
    if (typeof credentialId !== 'string') return undefined

    const credential = settings.skillsetCredentials?.[credentialId]
    if (!credential) {
      throw new Error('The repository credential is missing. Add the token again in Skillset settings.')
    }
    if (credential.type !== 'token' || !credential.token) {
      throw new Error('The repository credential is invalid. Add the token again in Skillset settings.')
    }
    return credential.token
  }

  private validateUrlForToken(url: string, token: string | undefined): void {
    if (!token) return

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Repository tokens currently support HTTPS github.com URLs only.')
    }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
      throw new Error('Repository tokens currently support HTTPS github.com URLs only.')
    }
    if (parsed.username || parsed.password) {
      throw new Error('Do not put credentials in the repository URL. Use the token field instead.')
    }
  }

  override async resolveCloneUrl(url: string, options?: SkillsetProviderRef): Promise<string> {
    const token = options ? this.getToken(options) : undefined
    this.validateUrlForToken(url, token)

    if (/^https?:\/\//i.test(url)) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('Repository URL is invalid.')
      }
      if (parsed.username || parsed.password) {
        throw new Error('Do not put credentials in the repository URL. Use the token field instead.')
      }
    }
    return url
  }

  override getGitEnvironment(ref: SkillsetProviderRef, baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const token = this.getToken(ref)
    this.validateUrlForToken(ref.skillsetUrl ?? '', token)
    if (!token) return baseEnvironment

    const basicCredential = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
    // extraHeader is multi-valued. Reset any inherited GitHub headers first so
    // a host-level credential cannot produce two competing Authorization lines.
    const resetEnvironment = appendGitConfig(
      baseEnvironment,
      'http.https://github.com/.extraHeader',
      '',
    )
    return appendGitConfig(
      resetEnvironment,
      'http.https://github.com/.extraHeader',
      `AUTHORIZATION: basic ${basicCredential}`,
    )
  }

  override getCliEnvironment(ref: SkillsetProviderRef, baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const token = this.getToken(ref)
    return token ? { ...baseEnvironment, GH_TOKEN: token } : baseEnvironment
  }

  async ensurePublishPreconditions(ref?: SkillsetProviderRef): Promise<void> {
    await this.ensureAuthenticated(ref)
  }

  private async ensureAuthenticated(ref?: SkillsetProviderRef): Promise<void> {
    const repositoryToken = ref ? this.getToken(ref) : undefined
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5000 })
    } catch {
      throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com')
    }

    try {
      const env = ref ? this.getCliEnvironment(ref, process.env) : process.env
      await execFileAsync('gh', ['auth', 'status'], { timeout: 5000, env })
    } catch {
      if (repositoryToken) {
        throw new Error('The repository token could not authenticate GitHub CLI. Check its repository access and permissions.')
      }
      throw new Error('GitHub CLI is not authenticated. Run `gh auth login` to sign in. See https://cli.github.com')
    }
  }

  override async publishUpdate(input: SkillsetPublishInput): Promise<SkillsetPublishResult> {
    const ctx = await this.prepareForkBranch(input, input.branchPrefix)
    const gitEnvironment = this.getGitEnvironment(input, BASE_GIT_ENV)

    for (const file of input.files) {
      const fullPath = path.join(input.repoDir, file.path)
      await ensureDirectory(path.dirname(fullPath))
      await fs.promises.writeFile(fullPath, file.content, 'utf-8')
    }

    const addPaths = input.gitAddPaths ?? ['.']
    await execFileAsync('git', ['add', ...addPaths], {
      cwd: input.repoDir, timeout: 10000, env: gitEnvironment,
    })

    await execFileAsync('git', ['commit', '-m', input.title], {
      cwd: input.repoDir, timeout: 10000, env: gitEnvironment,
    })

    const prUrl = await this.pushAndCreatePR(ctx, {
      title: input.title,
      body: input.body,
    })

    return { prUrl, successMessage: 'Pull request created successfully.' }
  }

  private async prepareForkBranch(
    input: SkillsetPublishInput,
    branchPrefix: string,
  ): Promise<ForkBranchContext> {
    const repoDir = input.repoDir
    const gitEnvironment = this.getGitEnvironment(input, BASE_GIT_ENV)
    const cliEnvironment = this.getCliEnvironment(input, process.env)
    await execFileAsync('git', ['checkout', '.'], {
      cwd: repoDir, timeout: 5000, env: gitEnvironment,
    }).catch(() => { /* ignore */ })

    const { stdout: upstreamNwoRaw } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: repoDir, timeout: 10000, env: cliEnvironment }
    )
    const upstreamNwo = upstreamNwoRaw.trim()

    await execFileAsync('gh', ['repo', 'fork', '--clone=false', '--remote=false'], {
      cwd: repoDir, timeout: 30000, env: cliEnvironment,
    })

    const { stdout: userLogin } = await execFileAsync(
      'gh', ['api', 'user', '--jq', '.login'],
      { timeout: 10000, env: cliEnvironment }
    )
    const forkOwner = userLogin.trim()
    const repoName = upstreamNwo.split('/')[1]

    const forkRemoteName = 'fork'
    const forkUrl = `https://github.com/${forkOwner}/${repoName}.git`

    try {
      await execFileAsync('git', ['remote', 'add', forkRemoteName, forkUrl], {
        cwd: repoDir, timeout: 5000, env: gitEnvironment,
      })
    } catch {
      await execFileAsync('git', ['remote', 'set-url', forkRemoteName, forkUrl], {
        cwd: repoDir, timeout: 5000, env: gitEnvironment,
      })
    }

    let baseBranch = 'main'
    try {
      const { stdout: originHead } = await execFileAsync(
        'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
        { cwd: repoDir, timeout: 5000, env: gitEnvironment }
      )
      baseBranch = originHead.trim().replace('refs/remotes/origin/', '')
    } catch {
      try {
        await execFileAsync('git', ['rev-parse', '--verify', 'origin/main'],
          { cwd: repoDir, timeout: 5000, env: gitEnvironment })
        baseBranch = 'main'
      } catch {
        baseBranch = 'master'
      }
    }

    await execFileAsync('git', ['checkout', baseBranch], {
      cwd: repoDir, timeout: 10000, env: gitEnvironment,
    })

    const branchName = `${branchPrefix}-${Date.now()}`
    await execFileAsync('git', ['checkout', '-b', branchName], {
      cwd: repoDir, timeout: 10000, env: gitEnvironment,
    })

    return {
      repoDir,
      upstreamNwo,
      forkOwner,
      baseBranch,
      branchName,
      gitEnvironment,
      cliEnvironment,
    }
  }

  private async pushAndCreatePR(
    ctx: ForkBranchContext,
    options: { title: string; body: string },
  ): Promise<string> {
    await execFileAsync('git', ['push', 'fork', ctx.branchName], {
      cwd: ctx.repoDir, timeout: 30000, env: ctx.gitEnvironment,
    })

    try {
      const { stdout: prStdout } = await execFileAsync(
        'gh',
        [
          'pr', 'create',
          '--repo', ctx.upstreamNwo,
          '--title', options.title,
          '--body', options.body,
          '--head', `${ctx.forkOwner}:${ctx.branchName}`,
          '--base', ctx.baseBranch,
        ],
        { cwd: ctx.repoDir, timeout: 30000, env: ctx.cliEnvironment }
      )
      return prStdout.trim()
    } finally {
      await execFileAsync('git', ['checkout', ctx.baseBranch], {
        cwd: ctx.repoDir, timeout: 10000, env: ctx.gitEnvironment,
      }).catch(() => { /* ignore */ })

      await execFileAsync('git', ['branch', '-D', ctx.branchName], {
        cwd: ctx.repoDir, timeout: 5000, env: ctx.gitEnvironment,
      }).catch(() => { /* ignore */ })
    }
  }
}
