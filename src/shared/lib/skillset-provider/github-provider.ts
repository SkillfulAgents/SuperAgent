import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { ensureDirectory } from '@shared/lib/utils/file-storage'
import {
  BaseSkillsetProvider,
  type SkillsetPublishInput,
  type SkillsetPublishResult,
} from './base-skillset-provider'

const execFileAsync = promisify(execFile)

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
}

interface ForkBranchContext {
  repoDir: string
  upstreamNwo: string
  forkOwner: string
  baseBranch: string
  branchName: string
}

export class GithubSkillsetProvider extends BaseSkillsetProvider {
  readonly id = 'github'
  readonly name = 'GitHub'
  readonly publishMode = 'pull_request' as const

  async ensurePublishPreconditions(): Promise<void> {
    await this.ensureAuthenticated()
  }

  private async ensureAuthenticated(): Promise<void> {
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5000 })
    } catch {
      throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com')
    }

    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 })
    } catch {
      throw new Error('GitHub CLI is not authenticated. Run `gh auth login` to sign in. See https://cli.github.com')
    }
  }

  override async publishUpdate(input: SkillsetPublishInput): Promise<SkillsetPublishResult> {
    const ctx = await this.prepareForkBranch(input.repoDir, input.branchPrefix)

    for (const file of input.files) {
      const fullPath = path.join(input.repoDir, file.path)
      await ensureDirectory(path.dirname(fullPath))
      await fs.promises.writeFile(fullPath, file.content, 'utf-8')
    }

    const addPaths = input.gitAddPaths ?? ['.']
    await execFileAsync('git', ['add', ...addPaths], {
      cwd: input.repoDir, timeout: 10000, env: GIT_ENV,
    })

    await execFileAsync('git', ['commit', '-m', input.title], {
      cwd: input.repoDir, timeout: 10000, env: GIT_ENV,
    })

    const prUrl = await this.pushAndCreatePR(ctx, {
      title: input.title,
      body: input.body,
    })

    return { prUrl, successMessage: 'Pull request created successfully.' }
  }

  private async prepareForkBranch(
    repoDir: string,
    branchPrefix: string,
  ): Promise<ForkBranchContext> {
    await execFileAsync('git', ['checkout', '.'], {
      cwd: repoDir, timeout: 5000, env: GIT_ENV,
    }).catch(() => { /* ignore */ })

    const { stdout: upstreamNwoRaw } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: repoDir, timeout: 10000 }
    )
    const upstreamNwo = upstreamNwoRaw.trim()

    await execFileAsync('gh', ['repo', 'fork', '--clone=false', '--remote=false'], {
      cwd: repoDir, timeout: 30000,
    })

    const { stdout: userLogin } = await execFileAsync(
      'gh', ['api', 'user', '--jq', '.login'],
      { timeout: 10000 }
    )
    const forkOwner = userLogin.trim()
    const repoName = upstreamNwo.split('/')[1]

    const forkRemoteName = 'fork'
    const forkUrl = `https://github.com/${forkOwner}/${repoName}.git`

    try {
      await execFileAsync('git', ['remote', 'add', forkRemoteName, forkUrl], {
        cwd: repoDir, timeout: 5000, env: GIT_ENV,
      })
    } catch {
      await execFileAsync('git', ['remote', 'set-url', forkRemoteName, forkUrl], {
        cwd: repoDir, timeout: 5000, env: GIT_ENV,
      })
    }

    let baseBranch = 'main'
    try {
      const { stdout: originHead } = await execFileAsync(
        'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
        { cwd: repoDir, timeout: 5000, env: GIT_ENV }
      )
      baseBranch = originHead.trim().replace('refs/remotes/origin/', '')
    } catch {
      try {
        await execFileAsync('git', ['rev-parse', '--verify', 'origin/main'],
          { cwd: repoDir, timeout: 5000, env: GIT_ENV })
        baseBranch = 'main'
      } catch {
        baseBranch = 'master'
      }
    }

    await execFileAsync('git', ['checkout', baseBranch], {
      cwd: repoDir, timeout: 10000, env: GIT_ENV,
    })

    const branchName = `${branchPrefix}-${Date.now()}`
    await execFileAsync('git', ['checkout', '-b', branchName], {
      cwd: repoDir, timeout: 10000, env: GIT_ENV,
    })

    return { repoDir, upstreamNwo, forkOwner, baseBranch, branchName }
  }

  private async pushAndCreatePR(
    ctx: ForkBranchContext,
    options: { title: string; body: string },
  ): Promise<string> {
    await execFileAsync('git', ['push', 'fork', ctx.branchName], {
      cwd: ctx.repoDir, timeout: 30000, env: GIT_ENV,
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
        { cwd: ctx.repoDir, timeout: 30000 }
      )
      return prStdout.trim()
    } finally {
      await execFileAsync('git', ['checkout', ctx.baseBranch], {
        cwd: ctx.repoDir, timeout: 10000, env: GIT_ENV,
      }).catch(() => { /* ignore */ })

      await execFileAsync('git', ['branch', '-D', ctx.branchName], {
        cwd: ctx.repoDir, timeout: 5000, env: GIT_ENV,
      }).catch(() => { /* ignore */ })
    }
  }
}
