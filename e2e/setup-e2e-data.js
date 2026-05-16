/**
 * Pre-server setup script for E2E tests.
 *
 * Runs BEFORE the Vite dev server starts (called from the webServer command
 * in playwright configs) so that settings.json is on disk before the first
 * call to getSettings(), which caches the result for the lifetime of the process.
 *
 * Usage:
 *   SUPERAGENT_DATA_DIR=.e2e-data node e2e/setup-e2e-data.js
 *   SUPERAGENT_DATA_DIR=.e2e-data-auth AUTH_MODE=true node e2e/setup-e2e-data.js
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const dataDir = process.env.SUPERAGENT_DATA_DIR
if (!dataDir) {
  console.error('[E2E Setup] SUPERAGENT_DATA_DIR not set')
  process.exit(1)
}

const resolvedDir = path.resolve(dataDir)

// Create directory
fs.mkdirSync(resolvedDir, { recursive: true })

// Remove DB files
for (const file of ['superagent.db', 'superagent.db-wal', 'superagent.db-shm']) {
  try { fs.unlinkSync(path.join(resolvedDir, file)) } catch { /* may not exist */ }
}

// Remove agents directory
try { fs.rmSync(path.join(resolvedDir, 'agents'), { recursive: true }) } catch { /* may not exist */ }

// Seed a fake skillset on disk so /discoverable-skills returns content
// without needing a real git remote.
//
// IMPORTANT: this MUST be a real `git init` repo, not just an empty `.git/`
// stub. The skillset-service runs `git remote set-url origin …` and
// `git pull` against this directory — and if `.git/` is malformed, git walks
// up the directory tree and operates on the project's repo instead, silently
// rewriting our actual origin URL. Real `git init` keeps git scoped here.
const SKILLSET_ID = 'e2e-test-skillset'
const SKILLSET_REPO_DIR = path.join(resolvedDir, 'skillset-cache', SKILLSET_ID)
const SKILLSET_FAKE_URL = 'https://localhost.invalid/e2e-test-skillset'
fs.rmSync(SKILLSET_REPO_DIR, { recursive: true, force: true })
fs.mkdirSync(SKILLSET_REPO_DIR, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: SKILLSET_REPO_DIR })

const SKILLSET_INDEX = {
  skillset_name: 'E2E Test Skillset',
  description: 'Fake skillset seeded for Playwright tests',
  version: '1.0.0',
  skills: [
    {
      name: 'e2e-plain-skill',
      path: 'skills/e2e-plain-skill/SKILL.md',
      description: 'A plain skill that needs no configuration',
      version: '1.0.0',
    },
    {
      name: 'e2e-env-skill',
      path: 'skills/e2e-env-skill/SKILL.md',
      description: 'A skill that requires an API key to run',
      version: '1.0.0',
    },
  ],
}
fs.writeFileSync(
  path.join(SKILLSET_REPO_DIR, 'index.json'),
  JSON.stringify(SKILLSET_INDEX, null, 2),
)

const PLAIN_SKILL_DIR = path.join(SKILLSET_REPO_DIR, 'skills', 'e2e-plain-skill')
fs.mkdirSync(PLAIN_SKILL_DIR, { recursive: true })
fs.writeFileSync(
  path.join(PLAIN_SKILL_DIR, 'SKILL.md'),
  `---
name: e2e-plain-skill
description: A plain skill that needs no configuration
metadata:
  version: 1.0.0
---

# E2E Plain Skill

This skill is seeded for end-to-end tests.
`,
)

const ENV_SKILL_DIR = path.join(SKILLSET_REPO_DIR, 'skills', 'e2e-env-skill')
fs.mkdirSync(ENV_SKILL_DIR, { recursive: true })
fs.writeFileSync(
  path.join(ENV_SKILL_DIR, 'SKILL.md'),
  `---
name: e2e-env-skill
description: A skill that requires an API key to run
metadata:
  version: 1.0.0
  required_env_vars:
    - name: E2E_TEST_API_KEY
      description: Fake API key for E2E tests
---

# E2E Env Skill

This skill requires an environment variable to be configured.
`,
)

// Commit the seed and add a fake origin. The commit makes this a valid git
// repo so subsequent `git remote set-url` / `git fetch` calls stay scoped to
// this directory rather than walking up to the host project.
const GIT_AUTHOR = ['-c', 'user.email=e2e@local', '-c', 'user.name=E2E Setup', '-c', 'commit.gpgsign=false']
execFileSync('git', [...GIT_AUTHOR, 'add', '.'], { cwd: SKILLSET_REPO_DIR, stdio: 'pipe' })
execFileSync('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'seed'], { cwd: SKILLSET_REPO_DIR, stdio: 'pipe' })
execFileSync('git', ['remote', 'add', 'origin', SKILLSET_FAKE_URL], { cwd: SKILLSET_REPO_DIR, stdio: 'pipe' })

// Seed a public-provider skillset (no .git, uses .skillset-cache-meta.json marker).
const PUBLIC_SKILLSET_ID = 'e2e-public-skillset'
const PUBLIC_SKILLSET_DIR = path.join(resolvedDir, 'skillset-cache', PUBLIC_SKILLSET_ID)
fs.rmSync(PUBLIC_SKILLSET_DIR, { recursive: true, force: true })
fs.mkdirSync(PUBLIC_SKILLSET_DIR, { recursive: true })

fs.writeFileSync(
  path.join(PUBLIC_SKILLSET_DIR, 'index.json'),
  JSON.stringify({
    skillset_name: 'E2E Public Skillset',
    description: 'Public skillset seeded for Playwright tests',
    version: '1.0.0',
    skills: [
      {
        name: 'e2e-public-skill',
        path: 'skills/e2e-public-skill/SKILL.md',
        description: 'A skill from the public skillset',
        version: '1.0.0',
      },
    ],
  }, null, 2),
)

const PUBLIC_SKILL_DIR = path.join(PUBLIC_SKILLSET_DIR, 'skills', 'e2e-public-skill')
fs.mkdirSync(PUBLIC_SKILL_DIR, { recursive: true })
fs.writeFileSync(
  path.join(PUBLIC_SKILL_DIR, 'SKILL.md'),
  `---
name: e2e-public-skill
description: A skill from the public skillset
metadata:
  version: 1.0.0
---

# E2E Public Skill

This skill is seeded from a public provider for end-to-end tests.
`,
)

fs.writeFileSync(
  path.join(PUBLIC_SKILLSET_DIR, '.skillset-cache-meta.json'),
  JSON.stringify({
    provider: 'public',
    cachedAt: new Date().toISOString(),
    sourceUrl: 'https://localhost.invalid/e2e-public-skillset',
  }, null, 2),
)
console.log(`[E2E Setup] Seeded public skillset at: ${PUBLIC_SKILLSET_DIR}`)

// Build settings
const settings = {
  container: {
    containerRunner: 'docker',
    agentImage: 'ghcr.io/skillfulagents/superagent-agent-container-base:latest',
    resourceLimits: { cpu: 1, memory: '512m' },
  },
  app: { setupCompleted: true },
  skillsets: [
    {
      id: SKILLSET_ID,
      url: SKILLSET_FAKE_URL,
      name: 'E2E Test Skillset',
      description: 'Fake skillset seeded for Playwright tests',
      addedAt: new Date().toISOString(),
      provider: 'github',
    },
    {
      id: PUBLIC_SKILLSET_ID,
      url: 'https://localhost.invalid/e2e-public-skillset',
      name: 'E2E Public Skillset',
      description: 'Public skillset seeded for Playwright tests',
      addedAt: new Date().toISOString(),
      provider: 'public',
    },
  ],
}

if (process.env.AUTH_MODE === 'true') {
  settings.apiKeys = { anthropicApiKey: 'sk-ant-e2e-mock-key' }
  settings.auth = {
    signupMode: 'open',
    passwordRequireComplexity: false,
    requireAdminApproval: false,
    passwordMinLength: 8,
  }
}

fs.writeFileSync(path.join(resolvedDir, 'settings.json'), JSON.stringify(settings, null, 2))
console.log(`[E2E Setup] Data dir prepared: ${resolvedDir}`)
console.log(`[E2E Setup] Seeded skillset at: ${SKILLSET_REPO_DIR}`)
